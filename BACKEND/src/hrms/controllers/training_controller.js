const Course = require("../models/course_model");
const CourseProgress = require("../models/course_progress_model");
const CourseAssignment = require("../models/course_assignment_model");
const SOPDocument = require("../models/sop_document_model");
const TrainingModule = require("../models/training_module_model");
const Quiz = require("../models/quiz_model");
const User = require("../models/user_model");
const mongoose = require("mongoose");

// ─── STATS ───────────────────────────────────────────────────────────────────

// GET /api/training/stats
exports.getTrainingStats = async (req, res) => {
  try {
    const userId = req.query.userId || req.user.userId;

    const completedModules = await CourseProgress.countDocuments({ userId, percentComplete: 100 });
    const inLearning = await CourseProgress.countDocuments({ userId, percentComplete: { $gt: 0, $lt: 100 } });

    let rank = "Bronze";
    if (completedModules >= 10) rank = "Gold";
    else if (completedModules >= 5) rank = "Silver";

    const timeAgg = await CourseProgress.aggregate([
      { $match: { userId: mongoose.Types.ObjectId.createFromHexString(userId) } },
      { $group: { _id: null, totalMins: { $sum: "$timeSpentMins" } } },
    ]);
    const totalTimeSpentMins = timeAgg[0]?.totalMins || 0;
    const passedQuizzes = await CourseProgress.countDocuments({ userId, passed: true });

    res.status(200).json({
      success: true,
      data: { completedModules: completedModules + " Modules", inLearning: inLearning + " Courses", rank, totalTimeSpentMins, passedQuizzes },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── COURSES / TRAINING CONTENT ───────────────────────────────────────────────

// GET /api/training/courses
// ?assignedOnly=true  →  return only courses assigned to the requesting user (staff view)
// (no param)          →  return all non-archived courses (admin view)
exports.getCourses = async (req, res) => {
  try {
    const userId = req.query.userId || req.user.userId;
    const assignedOnly = req.query.assignedOnly === "true";

    let courseFilter = {
      status: { $ne: "Archived" },
      tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null),
    };

    if (assignedOnly) {
      // Filter directly on Course.assignedTo — no extra collection lookup needed
      courseFilter.assignedTo = new mongoose.Types.ObjectId(userId);
    }

    const courses = await Course.find(courseFilter)
      .populate("targetDepartment", "name")
      .populate("uploadedBy", "name")
      .lean();

    // Collect all unique assignedTo IDs across courses, fetch users in one query
    const allAssignedIds = [...new Set(
      courses.flatMap((c) => (c.assignedTo || []).map(String))
    )].filter(Boolean);

    const usersMap = {};
    if (allAssignedIds.length) {
      const users = await User.find({ _id: { $in: allAssignedIds } })
        .select("name email employeeCode role avatar")
        .populate("role", "role")
        .lean();
      users.forEach((u) => { usersMap[String(u._id)] = u; });
    }

    const coursesWithProgress = await Promise.all(
      courses.map(async (course) => {
        const progress = await CourseProgress.findOne({ courseId: course._id, userId }).lean();
        const assignedUsers = (course.assignedTo || [])
          .map((id) => usersMap[String(id)])
          .filter(Boolean);
        return {
          ...course,
          assignedTo: assignedUsers,
          progress: progress ? progress.percentComplete : 0,
          progressStatus: progress ? progress.status : "not_started",
          startedAt: progress?.startedAt || null,
          completedAt: progress?.completedAt || null,
          timeSpentMins: progress?.timeSpentMins || 0,
          quizScore: progress?.quizScore ?? null,
          passed: progress?.passed ?? null,
          certificateIssued: progress?.certificateIssued || false,
          certificateUrl: progress?.certificateUrl || null,
        };
      })
    );

    res.status(200).json({ success: true, data: coursesWithProgress });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/training/courses  (multipart/form-data supported via multer)
exports.createCourse = async (req, res) => {
  try {
    const adminId = req.user.userId;

    // Parse JSON body fields that may come as strings in FormData
    const body = { ...req.body };
    if (typeof body.tags === "string") {
      try { body.tags = JSON.parse(body.tags); } catch { body.tags = body.tags.split(",").map((t) => t.trim()).filter(Boolean); }
    }
    if (typeof body.isMandatory === "string") body.isMandatory = body.isMandatory === "true";
    if (typeof body.totalLessons === "string") body.totalLessons = Number(body.totalLessons);
    if (typeof body.durationMins === "string") body.durationMins = Number(body.durationMins);

    // Resolve uploaded file paths (Cloudinary URL or local disk path)
    if (req.files?.length) {
      req.files.forEach((f) => {
        const fileUrl = f.path.startsWith("http") ? f.path : `/uploads/${f.filename}`.replace(/\\/g, "/");
        if (f.fieldname === "thumbnail") body.thumbnail = fileUrl;
        if (f.fieldname === "courseFile") body.fileUrl = fileUrl;
        if (f.fieldname === "videoFile") body.videoUrl = fileUrl;
        if (f.fieldname === "pdfFile") body.pdfUrl = fileUrl;
      });
    }

    const course = new Course({
      ...body,
      uploadedBy: adminId,
      tenant_id: req.user?.is_superadmin ? (req.body.tenant_id || null) : (req.user?.tenant_id || null),
    });
    await course.save();
    res.status(201).json({ success: true, data: course });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// DELETE /api/training/courses/:id
exports.deleteCourse = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const course = await Course.findOneAndDelete({ _id: id, ...tenantFilter });
    if (!course) {
      return res.status(404).json({ success: false, message: "Course not found" });
    }
    await CourseProgress.deleteMany({ courseId: id });
    await CourseAssignment.deleteOne({ courseId: id });
    res.status(200).json({ success: true, message: "Course deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/training/courses/:id
exports.getCourse = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const course = await Course.findOne({ _id: req.params.id, ...tenantFilter });
    if (!course) {
      return res.status(404).json({ success: false, message: "Course not found" });
    }
    res.status(200).json({ success: true, data: course });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// PUT /api/training/courses/:id (multipart/form-data supported via multer)
exports.updateCourse = async (req, res) => {
  try {
    const { id } = req.params;
    const body = { ...req.body };

    // Parse JSON body fields that may come as strings in FormData
    if (typeof body.tags === "string") {
      try { body.tags = JSON.parse(body.tags); } catch { body.tags = body.tags.split(",").map((t) => t.trim()).filter(Boolean); }
    }
    if (typeof body.isMandatory === "string") body.isMandatory = body.isMandatory === "true";
    if (typeof body.totalLessons === "string") body.totalLessons = Number(body.totalLessons);
    if (typeof body.durationMins === "string") body.durationMins = Number(body.durationMins);

    // Resolve uploaded file paths (Cloudinary URL or local disk path)
    if (req.files?.length) {
      req.files.forEach((f) => {
        const fileUrl = f.path.startsWith("http") ? f.path : `/uploads/${f.filename}`.replace(/\\/g, "/");
        if (f.fieldname === "thumbnail") body.thumbnail = fileUrl;
        if (f.fieldname === "courseFile") body.fileUrl = fileUrl;
        if (f.fieldname === "videoFile") body.videoUrl = fileUrl;
        if (f.fieldname === "pdfFile") body.pdfUrl = fileUrl;
      });
    }

    delete body.tenant_id; // never reassignable via this endpoint
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const course = await Course.findOneAndUpdate({ _id: id, ...tenantFilter }, body, { returnDocument: "after", runValidators: true });
    if (!course) {
      return res.status(404).json({ success: false, message: "Course not found" });
    }
    res.status(200).json({ success: true, data: course });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// PATCH /api/training/courses/:id/progress
exports.updateCourseProgress = async (req, res) => {
  try {
    const { id: courseId } = req.params;
    const userId = req.user.userId;
    const { completedLessons, percentComplete, timeSpentMins, quizScore, passed } = req.body;

    let progress = await CourseProgress.findOne({ courseId, userId });
    const now = new Date();

    if (progress) {
      if (completedLessons !== undefined) progress.completedLessons = completedLessons;
      if (percentComplete !== undefined) progress.percentComplete = percentComplete;
      if (timeSpentMins !== undefined) progress.timeSpentMins = (progress.timeSpentMins || 0) + timeSpentMins;
      if (quizScore !== undefined) progress.quizScore = quizScore;
      if (passed !== undefined) progress.passed = passed;

      if (percentComplete > 0 && percentComplete < 100) {
        progress.status = "in_progress";
        if (!progress.startedAt) progress.startedAt = now;
      } else if (percentComplete === 100) {
        progress.status = "completed";
        progress.completedAt = now;
        if (!progress.startedAt) progress.startedAt = now;
        progress.certificateIssued = true;
      }
      await progress.save();
    } else {
      const status = percentComplete === 100 ? "completed" : percentComplete > 0 ? "in_progress" : "not_started";
      progress = await CourseProgress.create({
        courseId,
        userId,
        completedLessons: completedLessons || 0,
        percentComplete: percentComplete || 0,
        timeSpentMins: timeSpentMins || 0,
        quizScore: quizScore ?? null,
        passed: passed ?? null,
        status,
        startedAt: percentComplete > 0 ? now : null,
        completedAt: percentComplete === 100 ? now : null,
        certificateIssued: percentComplete === 100,
      });
    }

    res.status(200).json({ success: true, data: progress });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── SOPs ─────────────────────────────────────────────────────────────────────

// GET /api/training/sops
exports.getSOPs = async (req, res) => {
  try {
    const userId = req.query.userId || req.user.userId;
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const sops = await SOPDocument.find({
      ...tenantFilter,
      $or: [{ userId }, { userId: null }, { userId: { $exists: false } }],
    }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: sops });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/training/sops
exports.createSOP = async (req, res) => {
  try {
    const sop = new SOPDocument({
      ...req.body,
      tenant_id: req.user?.is_superadmin ? (req.body.tenant_id || null) : (req.user?.tenant_id || null),
    });
    await sop.save();
    res.status(201).json({ success: true, data: sop });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// DELETE /api/training/sops/:id
exports.deleteSOP = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const sop = await SOPDocument.findOneAndDelete({ _id: id, ...tenantFilter });
    if (!sop) {
      return res.status(404).json({ success: false, message: "SOP not found" });
    }
    res.status(200).json({ success: true, message: "SOP deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── TRAINING MODULES ─────────────────────────────────────────────────────────

// GET /api/training/modules
exports.getModules = async (req, res) => {
  try {
    const modules = await TrainingModule.find({
      status: { $ne: "Archived" },
      tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null),
    })
      .populate("trainingItems.courseId", "title category contentType durationMins difficultyLevel thumbnail")
      .populate("createdBy", "name");

    res.status(200).json({ success: true, data: modules });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/training/modules
exports.createModule = async (req, res) => {
  try {
    const adminId = req.user.userId;
    const mod = new TrainingModule({
      ...req.body,
      createdBy: adminId,
      tenant_id: req.user?.is_superadmin ? (req.body.tenant_id || null) : (req.user?.tenant_id || null),
    });
    await mod.save();
    res.status(201).json({ success: true, data: mod });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// DELETE /api/training/modules/:id
exports.deleteModule = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const mod = await TrainingModule.findOneAndDelete({ _id: id, ...tenantFilter });
    if (!mod) {
      return res.status(404).json({ success: false, message: "Module not found" });
    }
    res.status(200).json({ success: true, message: "Module deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── QUIZZES ──────────────────────────────────────────────────────────────────

// GET /api/training/quizzes?linkedTo=<courseId>
exports.getQuizzes = async (req, res) => {
  try {
    const { linkedTo } = req.query;
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const filter = linkedTo ? { linkedTo, ...tenantFilter } : tenantFilter;
    const quizzes = await Quiz.find(filter);
    res.status(200).json({ success: true, data: quizzes });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/training/quizzes
exports.createQuiz = async (req, res) => {
  try {
    const adminId = req.user.userId;
    const quiz = new Quiz({
      ...req.body,
      createdBy: adminId,
      tenant_id: req.user?.is_superadmin ? (req.body.tenant_id || null) : (req.user?.tenant_id || null),
    });
    await quiz.save();
    res.status(201).json({ success: true, data: quiz });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// DELETE /api/training/quizzes/:id
exports.deleteQuiz = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const quiz = await Quiz.findOneAndDelete({ _id: id, ...tenantFilter });
    if (!quiz) {
      return res.status(404).json({ success: false, message: "Quiz question not found" });
    }
    res.status(200).json({ success: true, message: "Quiz question deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/training/quizzes/submit
exports.submitQuiz = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { courseId, answers } = req.body;

    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const questions = await Quiz.find({ linkedTo: courseId, ...tenantFilter });
    if (!questions.length) {
      return res.status(404).json({ success: false, message: "No quiz questions found for this course" });
    }

    let earnedMarks = 0;
    let totalMarks = 0;
    const results = questions.map((q) => {
      totalMarks += q.marks;
      const submitted = answers.find((a) => a.questionId === String(q._id));
      const correct = submitted?.selectedAnswer === q.correctAnswer;
      if (correct) earnedMarks += q.marks;
      return { questionId: q._id, correct, correctAnswer: q.correctAnswer };
    });

    const scorePercent = totalMarks > 0 ? Math.round((earnedMarks / totalMarks) * 100) : 0;

    const mod = await TrainingModule.findOne({ "trainingItems.courseId": courseId });
    const passed = mod?.passScore != null ? scorePercent >= mod.passScore : scorePercent >= 50;

    let progress = await CourseProgress.findOne({ courseId, userId });
    if (progress) {
      progress.quizScore = scorePercent;
      progress.passed = passed;
      await progress.save();
    } else {
      progress = await CourseProgress.create({ courseId, userId, quizScore: scorePercent, passed, status: "in_progress" });
    }

    res.status(200).json({ success: true, data: { scorePercent, passed, earnedMarks, totalMarks, results } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── COURSE ASSIGNMENTS ───────────────────────────────────────────────────────

// POST /api/training/courses/:id/assign
// body: { staffIds: ["userId1", "userId2", ...] }
// Saves assignedTo on the Course document itself AND in CourseAssignment.
exports.assignCourse = async (req, res) => {
  try {
    const { id: courseId } = req.params;
    const adminId = req.user.userId;
    const { staffIds } = req.body;

    if (!Array.isArray(staffIds) || staffIds.length === 0) {
      return res.status(400).json({ success: false, message: "staffIds must be a non-empty array" });
    }

    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const course = await Course.findOne({ _id: courseId, ...tenantFilter });
    if (!course) {
      return res.status(404).json({ success: false, message: "Course not found" });
    }

    const staffObjectIds = staffIds.map((id) => new mongoose.Types.ObjectId(id));

    // Write directly onto the Course document so it's visible in the DB
    course.assignedTo = staffObjectIds;
    course.assignedBy = new mongoose.Types.ObjectId(adminId);
    await course.save();

    // Keep CourseAssignment as audit record
    await CourseAssignment.findOneAndUpdate(
      { courseId },
      {
        $set: {
          assignedTo: staffObjectIds,
          assignedBy: new mongoose.Types.ObjectId(adminId),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const populated = await Course.findById(courseId)
      .populate("assignedTo", "name email employeeCode")
      .populate("assignedBy", "name");

    res.status(200).json({ success: true, data: populated });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/training/courses/:id/assignments
// Returns the staff assigned to a course with full name + role details.
exports.getCourseAssignments = async (req, res) => {
  try {
    const { id: courseId } = req.params;

    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const course = await Course.findOne({ _id: courseId, ...tenantFilter }).lean();
    if (!course) {
      return res.status(404).json({ success: false, message: "Course not found" });
    }

    const assignedIds = (course.assignedTo || []).filter(Boolean);

    // Direct User.find is more reliable than populate chains
    const assignedUsers = assignedIds.length
      ? await User.find({ _id: { $in: assignedIds } })
          .select("name email employeeCode role avatar")
          .populate("role", "role")
          .lean()
      : [];

    res.status(200).json({
      success: true,
      data: {
        courseId,
        assignedTo: assignedUsers,
        assignedBy: course.assignedBy || null,
        updatedAt: course.updatedAt,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /api/training/courses/:id/assign/:staffId
// Remove a single staff member from a course assignment.
exports.unassignStaffFromCourse = async (req, res) => {
  try {
    const { id: courseId, staffId } = req.params;

    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const course = await Course.exists({ _id: courseId, ...tenantFilter });
    if (!course) {
      return res.status(404).json({ success: false, message: "Course not found" });
    }

    const assignment = await CourseAssignment.findOneAndUpdate(
      { courseId },
      { $pull: { assignedTo: new mongoose.Types.ObjectId(staffId) } },
      { new: true }
    ).populate("assignedTo", "name email");

    if (!assignment) {
      return res.status(404).json({ success: false, message: "No assignment found for this course" });
    }

    res.status(200).json({ success: true, data: assignment });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

