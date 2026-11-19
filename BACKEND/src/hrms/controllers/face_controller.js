// HRMS Face Attendance (BOTLens integration).
//
//   Enrolment — admins capture 1-5 photos of an employee; each becomes an SFace
//               embedding stored in FaceProfile.
//   Kiosk     — an office device streams camera frames: /kiosk/recognize names
//               the faces it sees, /kiosk/punch re-verifies one face and punches
//               that employee in or out through the normal attendance handlers.
//   Selfie    — employees with a FaceProfile get their own punch selfies checked
//               (attendance_controller punchIn/punchOut).
//
// Face detection + embeddings come from the Python face service
// (CRM-BACKEND/face-service); matching is in utils/faceRecognition.js.

const User = require("../models/user_model");
const Attendance = require("../models/attendance_model");
const AttendanceEvent = require("../models/attendance_event_model");
const FaceProfile = require("../models/face_profile_model");
const attendanceController = require("./attendance_controller");
const { uploadToCloudinary } = require("../utils/cloudinary_config");
const { getISTDate, getISTTime } = require("../utils/timeUtils");
const { scopedUserFilter, scopedUserIds, canActOnEmployee, OUT_OF_SCOPE_MESSAGE } = require("../utils/branchScope");
const face = require("../utils/faceRecognition");
const { tenantHasFeature } = require("../../utils/tenantFeatures");

const MAX_ENROL_PHOTOS = 5;
const MIN_FACE_PX = 60; // enrolment face must be at least this wide in the photo
// A kiosk won't punch the same employee again within this window, so standing
// in front of the camera can't punch someone in and straight back out.
const KIOSK_COOLDOWN_SECONDS = Number(process.env.FACE_KIOSK_COOLDOWN_SECONDS) || 120;

const tenantOf = (req) => (req.user?.is_superadmin ? null : (req.user?.tenant_id || null));

const serviceDown = (res) =>
  res.status(503).json({
    success: false,
    serviceDown: true,
    message: "Face recognition service is not running. Ask your administrator to start it.",
  });

// The employee, if the requester may manage them (same tenant + supervisor branch scope).
async function employeeInScope(req, userId) {
  const emp = await User.findOne({ _id: userId, tenant_id: tenantOf(req) })
    .select("name employeeCode avatar isActive tenant_id hrmsBranchId");
  if (!emp) return { error: [404, "Employee not found"] };
  if (!(await canActOnEmployee(req, emp._id, ["view_attendance"]))) return { error: [403, OUT_OF_SCOPE_MESSAGE] };
  return { emp };
}

// Ids a supervisor's kiosk may recognise (their branches' staff), or null = everyone in the tenant.
async function allowedIdSet(req) {
  const ids = await scopedUserIds(req);
  return ids ? new Set(ids.map(String)) : null;
}

const nextActionFor = (attendance) =>
  attendance && attendanceController.hasOpenSession(attendance) ? "punch-out" : "punch-in";

// Runs an attendance handler (punchIn/punchOut) in-process and captures its
// first response — the handlers keep their side work (push, upload) running after it.
function runHandler(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

// One kiosk punch at a time per employee (two kiosks / two quick frames).
const punchesInFlight = new Set();
const lastKioskPunch = new Map(); // userId -> { at, action }

exports.getStatus = async (req, res) => {
  try {
    const empFilter = { tenant_id: tenantOf(req), isActive: true, ...(await scopedUserFilter(req)) };
    const ids = (await User.find(empFilter).select("_id").lean()).map((u) => u._id);
    const [serviceUp, enrolled] = await Promise.all([
      face.isServiceUp(),
      FaceProfile.countDocuments({ userId: { $in: ids } }),
    ]);
    res.json({
      success: true,
      data: { serviceUp, employees: ids.length, enrolled, threshold: face.MATCH_THRESHOLD, cooldownSeconds: KIOSK_COOLDOWN_SECONDS },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.listEnrollments = async (req, res) => {
  try {
    const query = { tenant_id: tenantOf(req), isActive: true, ...(await scopedUserFilter(req)) };
    if (req.query.branchId) query.hrmsBranchId = req.query.branchId;
    if (req.query.search) {
      const rx = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      query.$or = [{ name: rx }, { employeeCode: rx }, { mobile: rx }, { email: rx }];
    }
    const users = await User.find(query)
      .select("name employeeCode avatar mobile hrmsBranchId")
      .populate("hrmsBranchId", "name")
      .sort({ name: 1 })
      .limit(2000)
      .lean();
    const profiles = await FaceProfile.find({ userId: { $in: users.map((u) => u._id) } })
      .select("userId photoUrls embeddings updatedAt")
      .lean();
    const byUser = new Map(profiles.map((p) => [String(p.userId), p]));

    res.json({
      success: true,
      data: users.map((u) => {
        const p = byUser.get(String(u._id));
        return {
          _id: u._id,
          name: u.name,
          employeeCode: u.employeeCode || "",
          avatar: u.avatar || "",
          mobile: u.mobile || "",
          branch: u.hrmsBranchId?.name || "",
          enrolled: !!p,
          photoCount: p ? p.embeddings.length : 0,
          photoUrl: p?.photoUrls?.[0] || "",
          enrolledAt: p?.updatedAt || null,
        };
      }),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getEnrollment = async (req, res) => {
  try {
    const { emp, error } = await employeeInScope(req, req.params.userId);
    if (error) return res.status(error[0]).json({ success: false, message: error[1] });
    const p = await FaceProfile.findOne({ userId: emp._id }).select("photoUrls embeddings updatedAt").lean();
    res.json({
      success: true,
      data: { userId: emp._id, enrolled: !!p, photoCount: p ? p.embeddings.length : 0, photoUrl: p?.photoUrls?.[0] || "", enrolledAt: p?.updatedAt || null },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Whether the company has Face Attendance switched on, and whether the
// logged-in employee has an enrolled face. The frontend hides every Face
// Attendance entry point when enabled is false.
exports.getMyFace = async (req, res) => {
  try {
    const [enabled, p] = await Promise.all([
      req.user?.is_superadmin ? true : tenantHasFeature(req.user?.tenant_id, "face_attendance"),
      FaceProfile.findOne({ userId: req.user.userId }).select("updatedAt").lean(),
    ]);
    res.json({ success: true, data: { enabled, enrolled: enabled && !!p, enrolledAt: p?.updatedAt || null } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.enrollFace = async (req, res) => {
  try {
    const { emp, error } = await employeeInScope(req, req.params.userId);
    if (error) return res.status(error[0]).json({ success: false, message: error[1] });

    const files = (req.files || []).filter((f) => /^image\//.test(f.mimetype));
    if (!files.length || files.length > MAX_ENROL_PHOTOS) {
      return res.status(400).json({ success: false, message: `Add 1 to ${MAX_ENROL_PHOTOS} face photos` });
    }

    let results;
    try {
      results = await face.embedImages(files.map((f) => f.buffer), { maxFaces: 2 });
    } catch (err) {
      if (err instanceof face.FaceServiceUnavailable) return serviceDown(res);
      throw err;
    }

    // Every photo must show exactly one clear face.
    const embeddings = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const n = `Photo ${i + 1}`;
      if (r.error) return res.status(400).json({ success: false, message: `${n} could not be read. Use a JPG or PNG image.` });
      if (!r.faces.length) return res.status(400).json({ success: false, message: `No face found in ${n}. Face the camera in good light.` });
      if (r.faces.length > 1) return res.status(400).json({ success: false, message: `${n} has more than one face. Only ${emp.name} should be in the photo.` });
      if (r.faces[0].box[2] < MIN_FACE_PX) return res.status(400).json({ success: false, message: `The face in ${n} is too small. Move closer to the camera.` });
      embeddings.push(r.faces[0].embedding);
    }

    // The same person can't be enrolled under two employees (proxy attendance).
    const others = await face.tenantProfiles(emp.tenant_id);
    for (const e of embeddings) {
      const clash = face.matchFace(e, others, null, emp._id);
      if (clash) {
        const other = await User.findById(clash.userId).select("name").lean();
        return res.status(409).json({
          success: false,
          message: `This face is already enrolled for ${other?.name || "another employee"}. Remove that enrolment first if it is wrong.`,
        });
      }
    }

    const photoUrls = (
      await Promise.all(files.map((f) => uploadToCloudinary(f, "hrms/face").catch(() => null)))
    ).filter(Boolean);

    const profile = await FaceProfile.findOneAndUpdate(
      { userId: emp._id },
      { userId: emp._id, tenant_id: emp.tenant_id || null, embeddings, photoUrls, enrolledBy: req.user.userId || null },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    face.invalidateTenant(emp.tenant_id);

    res.json({
      success: true,
      message: `Face enrolled for ${emp.name}`,
      data: { userId: emp._id, enrolled: true, photoCount: embeddings.length, photoUrl: photoUrls[0] || "", enrolledAt: profile.updatedAt },
    });
  } catch (error) {
    console.error("Face enrol error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.removeEnrollment = async (req, res) => {
  try {
    const { emp, error } = await employeeInScope(req, req.params.userId);
    if (error) return res.status(error[0]).json({ success: false, message: error[1] });
    await FaceProfile.deleteOne({ userId: emp._id });
    face.invalidateTenant(emp.tenant_id);
    res.json({ success: true, message: `Face enrolment removed for ${emp.name}` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// One camera frame → who is in it. No side effects.
exports.kioskRecognize = async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ success: false, message: "frame is required" });

    let result;
    try {
      [result] = await face.embedImages([req.file.buffer], { maxFaces: 5 });
    } catch (err) {
      if (err instanceof face.FaceServiceUnavailable) return serviceDown(res);
      throw err;
    }
    if (!result || result.error) return res.status(400).json({ success: false, message: "Invalid camera frame" });

    const [profiles, allowed] = await Promise.all([face.tenantProfiles(tenantOf(req)), allowedIdSet(req)]);
    const matches = result.faces.map((f) => face.matchFace(f.embedding, profiles, allowed));
    const ids = [...new Set(matches.filter(Boolean).map((m) => m.userId))];

    const [users, todays] = ids.length
      ? await Promise.all([
          User.find({ _id: { $in: ids }, isActive: true }).select("name employeeCode avatar").lean(),
          Attendance.find({ userId: { $in: ids }, date: getISTDate() }).lean(),
        ])
      : [[], []];
    const userById = new Map(users.map((u) => [String(u._id), u]));
    const attByUser = new Map(todays.map((a) => [String(a.userId), a]));

    res.json({
      success: true,
      data: {
        width: result.width,
        height: result.height,
        faces: result.faces.map((f, i) => {
          const m = matches[i];
          const u = m && userById.get(m.userId);
          const att = u && attByUser.get(m.userId);
          return {
            box: f.box,
            pose: f.pose,
            match: u
              ? {
                  userId: m.userId,
                  name: u.name,
                  employeeCode: u.employeeCode || "",
                  avatar: u.avatar || "",
                  similarity: Math.round(m.score * 100) / 100,
                  nextAction: nextActionFor(att),
                  onLunch: !!att && attendanceController.isLunchOpen(att),
                }
              : null,
          };
        }),
      },
    });
  } catch (error) {
    console.error("Face kiosk recognize error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Punch one recognised employee in or out. The frame is re-checked here so a
// kiosk can't punch someone who isn't actually in front of the camera.
exports.kioskPunch = async (req, res) => {
  const { userId } = req.body;
  if (!userId || !req.file?.buffer) {
    return res.status(400).json({ success: false, message: "userId and frame are required" });
  }
  if (punchesInFlight.has(String(userId))) {
    return res.json({ success: false, skipped: true, message: "Already processing this employee" });
  }
  punchesInFlight.add(String(userId));
  try {
    const { emp, error } = await employeeInScope(req, userId);
    if (error) return res.status(error[0]).json({ success: false, message: error[1] });
    if (!emp.isActive) return res.status(400).json({ success: false, message: `${emp.name} is inactive` });
    const employee = { _id: emp._id, name: emp.name, employeeCode: emp.employeeCode || "", avatar: emp.avatar || "" };

    const profile = await FaceProfile.findOne({ userId: emp._id }).select("embeddings").lean();
    if (!profile) return res.status(400).json({ success: false, message: `${emp.name} has no enrolled face` });

    let result;
    try {
      [result] = await face.embedImages([req.file.buffer], { maxFaces: 5 });
    } catch (err) {
      if (err instanceof face.FaceServiceUnavailable) return serviceDown(res);
      throw err;
    }
    const verified = (result?.faces || []).some((f) => face.profileScore(f.embedding, profile) >= face.MATCH_THRESHOLD);
    if (!verified) {
      return res.status(409).json({ success: false, employee, message: `Couldn't confirm ${emp.name}'s face. Look at the camera and try again.` });
    }

    // Cooldown: the in-process record, backed by today's event log (other kiosks / restarts).
    const date = getISTDate();
    const recent = lastKioskPunch.get(String(emp._id));
    const lastEvent = await AttendanceEvent.findOne({ employeeId: emp._id, date }).sort({ at: -1 }).select("at type").lean();
    const lastAt = Math.max(recent?.at || 0, lastEvent?.at ? new Date(lastEvent.at).getTime() : 0);
    if (Date.now() - lastAt < KIOSK_COOLDOWN_SECONDS * 1000) {
      const lastAction = recent && recent.at >= (lastEvent?.at ? new Date(lastEvent.at).getTime() : 0)
        ? recent.action
        : lastEvent?.type === "PUNCH_IN" ? "punch-in" : "punch-out";
      return res.json({
        success: false,
        skipped: true,
        employee,
        action: lastAction,
        message: `${emp.name} already ${lastAction === "punch-in" ? "punched in" : "punched out"} just now`,
      });
    }

    const attendance = await Attendance.findOne({ userId: emp._id, date });
    const action = nextActionFor(attendance);
    const handler = action === "punch-out" ? attendanceController.punchOut : attendanceController.punchIn;

    const { status, body } = await runHandler(handler, {
      body: {},
      headers: {},
      app: req.app,
      user: { userId: String(emp._id), tenant_id: emp.tenant_id || null },
      file: { buffer: req.file.buffer, mimetype: req.file.mimetype || "image/jpeg", originalname: `face-${action}.jpg`, size: req.file.size },
      punchSource: "face_kiosk",
    });

    const ok = status < 300;
    if (ok) lastKioskPunch.set(String(emp._id), { at: Date.now(), action });
    res.status(ok ? 200 : status).json({
      success: ok,
      action,
      employee,
      time: getISTTime(),
      message: body?.message || (ok ? "Done" : "Punch failed"),
    });
  } catch (error) {
    console.error("Face kiosk punch error:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    punchesInFlight.delete(String(userId));
  }
};
