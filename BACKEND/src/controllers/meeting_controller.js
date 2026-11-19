const Meeting = require("../models/Meeting");
const Staff = require("../models/Staff");
const { logActivity } = require("../services/ActivityLogService");
const { uploadMeetingRecording, getSignedPlaybackUrl, deleteMeetingRecording } = require("../services/meetingRecordingService");
// Reuse CRM Agent's CRM tool set (search_records/verify_record/etc.) and AI
// client instead of duplicating them — Scribe answers CRM questions the same way
// the main chat assistant does, just triggered from a live meeting transcript.
const { tools: crmTools, runTools: runCrmTools, client: aiClient, MODEL: AI_MODEL, getAiAgentName } = require("./assistant_controller");

const MEMBER_FIELDS = "firstname lastname email admin is_superadmin";

// Strips ```json fences (or bare ```) Claude sometimes wraps JSON in, despite
// being told not to — defensive, since we parse the reply as JSON either way.
const parseJsonReply = (text) => {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  return JSON.parse(cleaned);
};

// Live Scribe only ever gets read tools — it must never create/update/delete/
// navigate during a passive listening session. This is enforced here (not just
// via prompt instruction): these are the only three tool schemas sent to Claude,
// so it is physically unable to request anything else.
const SCRIBE_READ_ONLY_TOOLS = crmTools.filter((t) => ["search_records", "verify_record", "get_analytics"].includes(t.name));
const SCRIBE_TOOL_LIST = SCRIBE_READ_ONLY_TOOLS.map((t) => t.name).join(", ");

const SCRIBE_LIVE_SYSTEM_PROMPT = (meeting, hasExternalParticipant, participantsLabel, answeredKeys, agentName = "CRM Agent") => `You are ${agentName}, the live CRM assistant inside the Fuerte meeting scribe.

You start automatically when the meeting starts. There is NO wake word. You listen continuously and answer every CRM question yourself, in Hindi.

TODAY: ${new Date().toISOString().slice(0, 10)}
MEETING: ${meeting.topic} (agenda: ${meeting.agenda || "N/A"}, started: ${meeting.date?.toISOString?.().slice(0, 10) || "N/A"} ${meeting.time || ""})
PARTICIPANTS: ${participantsLabel || "not recorded"}
HAS_EXTERNAL_PARTICIPANT: ${hasExternalParticipant ? "true" : "false"}
CRM SNAPSHOT: (not preloaded for this meeting — use tools for every lookup)
AVAILABLE TOOLS: ${SCRIBE_TOOL_LIST}
ALREADY_ANSWERED: ${answeredKeys && answeredKeys.length ? answeredKeys.join(", ") : "(none yet)"}

RULE 1 — MODULE MAP. YAHAN SE SHURU KAREIN.
Jawab dene se pehle SABSE PEHLE ye decide karein: sawaal kis module ka hai? Galat module chunna = "jawab nahi mila" — aur yahi sabse aam galti hai.
IMPORTANT — is CRM me "deal" naam ka module NAHI hai. Koi "deal" bole to proposals aur estimates dono dekhein. Deal dhoondh kar khaali haath na lautein.
Log jo bolte hain -> jahan dekhna hai: deal/sauda -> proposals+estimates; quotation/quote -> estimates+quotations; bill/बिल -> invoices; PO/purchase order -> purchases; paisa aaya/payment -> payments; bakaya/outstanding -> invoices(unpaid) minus payments; ticket/complaint -> tickets; enquiry/पूछताछ -> leads+estimate_requests; AMC/renewal -> contracts+subscriptions; refund -> credit_notes; kaam/task -> tasks; site/साइट -> projects; target -> goals; chhutti/leave -> leaves (internal only, Tier 3 blocked); hajiri/attendance -> attendance (internal only, Tier 3 blocked).
Poore module list: customers (detail/group/contact), leads (count/source/status/owner), estimate_requests (enquiry/status), proposals (bheja/amount/accepted/expiry), estimates (bheja/amount/approved/converted), quotations (banaya/type), invoices (bheja/amount/paid-unpaid-partial/due date), payments (received/amount/date/mode), credit_notes (refund/amount), items (rate/description/tax), purchases (PO/vendor/amount/status), vendors (detail/payment), subscriptions (active/renewal/amount), contracts (type/signed/dates), projects (status/progress%/deadline/handover/members), tasks (pending/assignee/due date/priority/status), tickets (open-closed/priority/department/assignee), kb_articles/faqs (present or not), calendar_events (schedule), goals (target vs achieved), activity_log (kisne kya badla), reports (sales total/expenses vs income/lead conversion/timesheet — aggregate, ginna padega).
Ek sawaal do module ka ho sakta hai — "Sharma ka kitna bakaya hai?" ke liye invoices AUR payments dono chahiye, dono dekhein phir ginein.

RULE 2 — DATA KAHAN SE LEIN
CRM SNAPSHOT me jo module hai wahan se seedha padhein (fastest). Snapshot me na ho to AVAILABLE TOOLS se us module ka tool call karein. Tool bhi na ho to keh dein: "यह module अभी connect नहीं है।" — ye "record nahi mila" se ALAG hai, dono ko mix na karein warna pata nahi chalega data missing hai ya connection missing hai.

RULE 3 — KYA BOL SAKTE HAIN, KYA NAHI
TIER 1 (kisi bhi participant ke saamne, customer khud bhi ho to): us customer ka apna data — uske invoices, payments, projects, tasks, tickets, proposals, estimates, contracts, subscriptions, outstanding.
TIER 2 (sirf jab HAS_EXTERNAL_PARTICIPANT false ho): company totals, sab customers ki sales, lead counts, goals, activity log, reports, staff naam aur role, departments, branches, shifts, expenses, vendor pricing, item cost, margin, internal notes.
TIER 3 (KABHI NAHI — kisi bhi meeting me, kisi bhi participant ke saath, external ho ya na ho): payroll/salary/CTC, session_logs, live_tracking (kisi ki location), device_approvals, kisi bhi employee ki attendance ya leave record. Aise sawaal pe: action "blocked", reply "यह जानकारी meeting में नहीं दी जा सकती। CRM panel में देखिए।" — kabhi partial jawab na dein, "thoda bata dete hain" bhi nahi.
Doosre customer ka data kabhi na bolein jab pehla customer room me ho. Field internal hai ya nahi doubt ho to bilkul na bolein.

RULE 4 — EK SAWAAL, EK JAWAB
Har jawab ke saath key banayein: "<module>:<record_id>:<field>" — Sharma ka payment aaya? -> "payments:CUST-88:status"; Sharma ka kitna bakaya? -> "payments:CUST-88:status" (same key); Andheri handover kab? -> "projects:P-233:handover_date"; Is mahine kitne leads? -> "leads:ALL:count_month". Key module+record+field se banti hai, shabdon se nahi — alag shabdon me wahi sawaal same key dega, dobara jawab nahi.
ALREADY_ANSWERED me key ho -> action "silent". EXCEPTION: koi kahe "phir se batao"/"repeat karo" -> jawab dein, is_repeat true karein.

RULE 5 — DATA CHECK, JAWAB SE PEHLE
1. MODULE SAHI? Jo module chuna wahi sawaal ka hai — "invoice bheja?" ke liye payments dekhna galat hai, invoice bhejna aur payment aana do alag cheezein hain.
2. NAAM MILA? Record ka naam wahi hai jo poochha gaya — "Sharma Construction" poochha aur "Sharma Textiles" mila to match NAHI hai.
3. TOTAL GINA? Total/sum/count poochha ho to list se ginein, ek record ke field ko total maan kar na padhein — outstanding = sum(unpaid invoices) - sum(payments received).
4. KHAALI vs NAHI — teen alag jawab: empty list -> "CRM में ऐसा record नहीं है।"; record hai field null -> "record है, पर यह field भरी नहीं है।"; module connect nahi -> "यह module अभी connect नहीं है।"
5. EK SE ZYADA MATCH? Khud na chunein — action "clarify", sabke naam aur id batakar poochhein, latest/biggest/pehla ko default na banayein.
6. NAAM WAAPAS BOLEIN taaki insaan pakad sake galat record utha to ("शर्मा Construction का payment...", sirf "payment pending है" nahi).
Naam, amount, date, status, stage kabhi invent na karein. Pata na ho to bol dein pata nahi.

RULE 6 — KAB CHUP RAHEIN
action "silent" jab: answer_key already answered hai; greeting/small talk/personal baat; "haan haan"/"theek hai"/"achha"/"dekhte hain"/"hmm"; human decision ("discount de dein?", "kisko bhejna chahiye?"); koi insaan already jawab de raha hai (galat ho tab bhi); vaakya adhoora hai. Doubt ho to jawab de dein, confidence "low" rakhein — chup rehna default nahi hai, sirf in cases me hai.

RULE 7 — HINDI, CHHOTA JAWAB
Sab jawab Hindi (Devanagari) me, sawaal English me ho to bhi. Business words English me: payment, invoice, proposal, estimate, project, site, task, ticket, lead, status, pending, approval, quotation, GST, PO, follow-up, handover, outstanding, material, budget, client, vendor. भुगतान, चालान, परियोजना, लंबित — kabhi na likhein. Always आप.
Maximum 2 vaakya — number, date, naam, record id, bas. No preamble ("मैं देखता हूँ", "एक मिनट" kabhi nahi). No sign-off ("कुछ और चाहिए?" kabhi nahi).
Good: "शर्मा Construction का ढाई लाख outstanding है, 2 invoices unpaid। — INV-2291, INV-2304"
Bad: "मैंने CRM में देखा तो पता चला कि..."

RULE 8 — NAAM, NUMBER, DATE
Naam: CRM me English letters, speech Devanagari me — pehle transliterate karein (शर्मा कंस्ट्रक्शन -> Sharma Construction), जी/ji/साहब/सर/भाई hatayein ("शर्मा जी" -> "Sharma"), variants: Sharma/Sarma, Agarwal/Agrawal, Gupta/Gupt, Mehta/Mehata, Jain/Jaine, Shah/Sheth, Verma/Varma, Naik/Nayak.
Number: लाख=100000, करोड़=10000000, डेढ़=1.5x, ढाई=2.5x, सवा=1.25x, साढ़े तीन=3.5x, पौने चार=3.75x — search plain digits (250000), bolein "ढाई लाख", padhein 45,00,000.
Date: कल = yesterday YA tomorrow, verb tense se decide karein ("कल भेजा था"=yesterday, "कल भेजूंगा"=tomorrow). Clear na ho to poochhein. दिवाली/होली ki date guess kabhi nahi.

Use ${SCRIBE_TOOL_LIST} to look up real CRM data and run the RULE 5 checks before every answer. You are read-only — these tools never create, edit, or delete anything.

Return ONLY this JSON, no markdown fences, no preamble:
{
  "a": "ans" | "clarify" | "none" | "silent" | "blocked" | "no_module",
  "r": "जवाब — 1 से 2 वाक्य, देवनागरी में",
  "mod": "invoices",
  "k": "invoices:CUST-88:outstanding",
  "src": ["INV-2291", "INV-2304"],
  "name": "Sharma Construction",
  "tier": 1,
  "conf": "high" | "medium" | "low",
  "is_repeat": false,
  "x": "reason in English if not answered, else null"
}
"r" is listed first on purpose — if you ever stream, it should come first so TTS can start immediately. "is_repeat" is not in the caller's original field list but is required whenever RULE 4's repeat exception applies — always include it.`;

// Diagnostic variant of the live prompt above — "stay_silent" doesn't exist
// here, every input gets a verdict explaining exactly why it did or didn't
// answer. Used only by the manual test box in the Scribe dialog, never by the
// live auto-listening flow, so you can debug a specific line of speech
// (why didn't it find Sharma? was "?" even detected?) without a live meeting.
const SCRIBE_DIAGNOSTIC_SYSTEM_PROMPT = (meeting, participantsLabel, answeredKeys, agentName = "CRM Agent") => `You are ${agentName} in DIAGNOSTIC MODE.

In this mode "stay_silent" DOES NOT EXIST. You must return a response to every single input, always, without exception. If you cannot answer, you must say exactly WHY. Silence is a bug in this mode, not a feature.

TODAY: ${new Date().toISOString().slice(0, 10)}
MEETING: ${meeting.topic} (agenda: ${meeting.agenda || "N/A"})
PARTICIPANTS: ${participantsLabel || "not recorded"}
ALREADY_ANSWERED: ${answeredKeys && answeredKeys.length ? answeredKeys.join(", ") : "(none yet)"}

For every input, decide ONE of these and always return it:
  "answered" — CRM data me jawab mila. Do vaakya me batayein.
  "no_question" — Ye sawaal hi nahi tha. Batayein ye kya tha (greeting / small talk / statement / adhoora vaakya).
  "not_crm" — Sawaal hai, par CRM ka nahi. Batayein kis cheez ka hai.
  "no_record" — CRM ka sawaal hai, par snapshot me record nahi mila. Batayein aapne kaun sa naam khoja tha.
  "field_empty" — Record mila, par jo field poochhi wo khaali hai. Field ka naam batayein.
  "many_matches" — Ek se zyada record mila. Sabke naam aur id batayein.
  "already_done" — Key ALREADY_ANSWERED me hai. Key batayein.
  "human_answered" — Kisi insaan ne already jawab de diya. Uska naam batayein.
  "data_wrong" — Data me gadbad lagi. Kaun sa check fail hua, batayein.

RULES
- Har input pe kuch return karein. Khaali response kabhi nahi.
- Doubt ho to "answered" chunein aur confidence "low" rakhein — diagnostic mode me galat jawab chup rehne se behtar hai, hum debug kar rahe hain.
- "no_question" chunte waqt ye zaroor batayein ki text me question word tha ya nahi — isse pata chalega backend ka regex galat hai ya nahi.
- Naam khoja ho to jo Latin spelling try ki wo likhein — dono heard aur searched form.
- Jawab Hindi (Devanagari) me. Business words English me: payment, invoice, project, site, deal, status, pending, outstanding.
- Reason field English me rakhein — wo log ke liye hai, user ke liye nahi.

Use search_records/verify_record/get_analytics to actually look up CRM data before deciding the verdict.

Return ONLY this JSON, no markdown fences, no preamble:
{
  "verdict": "answered" | "no_question" | "not_crm" | "no_record" | "field_empty" | "many_matches" | "already_done" | "human_answered" | "data_wrong",
  "reply_hi": "जवाब, या null अगर answered नहीं है",
  "reason": "exact reason in English, for the log",
  "answer_key": "CUST-88:payment_status, or null",
  "had_question_word": true,
  "name_heard": "शर्मा कंस्ट्रक्शन, or null",
  "name_searched": "Sharma Construction, or null",
  "records_found": 0,
  "confidence": "high" | "medium" | "low"
}`;

const SCRIBE_CLOSE_SYSTEM_PROMPT = (meeting, agentName = "CRM Agent") => `You are ${agentName} Scribe, closing out a meeting inside the Fuerte CRM.

MEETING: ${meeting.topic} (agenda: ${meeting.agenda || "N/A"}, date: ${meeting.date?.toISOString?.().slice(0, 10) || "N/A"})

You are given the full transcript. Build the meeting record from it.
- The agenda is what was ACTUALLY discussed, in the order it came up — not what was planned but skipped.
- A decision goes in "decisions" only if someone clearly agreed ("हाँ, ऐसा ही करेंगे" is a decision; "देख लेंगे" is not).
- An action item needs an owner if one was named; if not, owner is null — never assign it yourself.
- Convert relative dates (कल/परसों/festival-relative) to real dates using the meeting's date above; if genuinely unclear, put it in needs_review instead of guessing.
- "open_questions_hi" is for things raised but not resolved.
- "crm_updates_suggested" are SUGGESTIONS only — you never write to the CRM yourself, a human approves them.
- Never invent a name, amount, date, stage, or status. If the transcript is too short/unclear to summarize, say so in needs_review and leave arrays empty.
- summary_hi is in Hindi (Devanagari, business words kept in English as people actually speak them); summary_en is the same meaning in English so the record is searchable either way.

Return ONLY this JSON, no markdown fences, no preamble:
{
  "summary_hi": "3 to 5 sentences in Hindi",
  "summary_en": "same meaning in English",
  "agenda": [{ "order": 1, "topic_hi": "...", "points_hi": ["..."], "start_time": "00:04:12" }],
  "decisions": [{ "decision_hi": "...", "agreed_by": ["..."] }],
  "action_items": [{ "task_hi": "...", "owner": "...", "due_date": "2026-08-01" }],
  "open_questions_hi": ["..."],
  "crm_updates_suggested": [{ "entity": "project", "id": "P-233", "field": "handover_date", "suggested_value": "2026-08-22", "reason": "..." }],
  "needs_review": ["..."]
}`;

// Non-admin, non-superadmin staff only ever see meetings they were added to
// as a member — admins/superadmins keep seeing every meeting in the tenant.
const scopeToOwnMeetings = (req, filter) => {
  if (req.user?.admin || req.user?.is_superadmin) return filter;
  if (req.user?._id) filter.members = req.user._id;
  return filter;
};

// A mongo filter fragment restricting to the requester's own tenant — added
// to every single-meeting query below (findOne*, or checked after findById)
// so a valid meeting ID belonging to a DIFFERENT tenant can never be read,
// updated, deleted, or have a recording attached, even by a guessed/leaked ID.
// Mirrors getMeetings' own filter (superadmin, or no tenant_id on the user,
// bypasses it) so behavior stays consistent across every meeting endpoint.
const tenantMatchFilter = (req) => {
  if (req.user?.is_superadmin || !req.user?.tenant_id) return {};
  return { tenant_id: req.user.tenant_id };
};

// Fetches one meeting already scoped to the requester's tenant — returns null
// (treated as 404, same as "not found") rather than exposing that a
// differently-tenanted meeting exists at all.
const findTenantMeeting = (req, id, { populate = false } = {}) => {
  let query = Meeting.findOne({ _id: id, ...tenantMatchFilter(req) });
  if (populate) query = query.populate("members", MEMBER_FIELDS);
  return query;
};

// Get all meetings
exports.getMeetings = async (req, res) => {
  try {
    let filter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;
    filter = scopeToOwnMeetings(req, filter);
    const meetings = await Meeting.find(filter).sort({ createdAt: -1 }).populate("members", MEMBER_FIELDS);
    res.json(meetings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get a single meeting
exports.getMeetingById = async (req, res) => {
  try {
    const meeting = await findTenantMeeting(req, req.params.id, { populate: true });
    if (!meeting) return res.status(404).json({ message: "Meeting not found" });
    res.json(meeting);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Create a meeting
exports.createMeeting = async (req, res) => {
  try {
    const meeting = await Meeting.create({ ...req.body, tenant_id: req.user?.tenant_id });
    await meeting.populate("members", MEMBER_FIELDS);
    logActivity(req, `Scheduled meeting: ${meeting.topic}`, { rel_id: meeting._id, rel_type: "meeting" });
    res.status(201).json(meeting);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Update a meeting
exports.updateMeeting = async (req, res) => {
  try {
    const meeting = await Meeting.findOneAndUpdate({ _id: req.params.id, ...tenantMatchFilter(req) }, req.body, { new: true }).populate("members", MEMBER_FIELDS);
    if (!meeting) return res.status(404).json({ message: "Meeting not found" });
    logActivity(req, `Updated meeting: ${meeting.topic}`, { rel_id: meeting._id, rel_type: "meeting" });
    res.json(meeting);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Delete a meeting
exports.deleteMeeting = async (req, res) => {
  try {
    const meeting = await Meeting.findOneAndDelete({ _id: req.params.id, ...tenantMatchFilter(req) });
    if (!meeting) return res.status(404).json({ message: "Meeting not found" });
    logActivity(req, `Deleted meeting: ${meeting.topic}`, { rel_type: "meeting" });
    res.json({ message: "Meeting deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Bulk import meetings from CSV/Excel rows
exports.importMeetings = async (req, res) => {
  try {
    const rowsRaw = Array.isArray(req.body) ? req.body : req.body.meetings;
    if (!rowsRaw || !Array.isArray(rowsRaw) || rowsRaw.length === 0) {
      return res.status(400).json({ message: "No valid meeting data provided" });
    }

    const tenantId = req.user?.tenant_id;

    const parseDate = (v) => {
      if (!v) return undefined;
      const d = new Date(v);
      return isNaN(d.getTime()) ? undefined : d;
    };
    const rawMemberTokens = (v) => {
      if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
      if (!v) return [];
      return String(v).split(",").map((s) => s.trim()).filter(Boolean);
    };

    // Members in the import sheet are emails/names, not ids — resolve each
    // token against this tenant's Staff by email, falling back to full name.
    const tenantStaff = await Staff.find(tenantId ? { tenant_id: tenantId } : {}).select("_id firstname lastname email").lean();
    const byEmail = new Map(tenantStaff.map((s) => [s.email?.toLowerCase(), s]));
    const byName = new Map(tenantStaff.map((s) => [`${s.firstname} ${s.lastname}`.toLowerCase(), s]));
    let unmatchedMembers = 0;
    const resolveMembers = (v) =>
      rawMemberTokens(v)
        .map((token) => {
          const match = byEmail.get(token.toLowerCase()) || byName.get(token.toLowerCase());
          if (!match) unmatchedMembers++;
          return match?._id;
        })
        .filter(Boolean);

    const rows = rowsRaw
      .map((r) => {
        const topic = r.topic || r.Topic || "";
        const agenda = r.agenda || r.Agenda || "";
        const date = parseDate(r.date || r.Date);
        if (!topic || !agenda || !date) return null;
        return {
          topic,
          agenda,
          date,
          time: r.time || r.Time || undefined,
          members: resolveMembers(r.members || r.Members),
          meeting_type: r.meeting_type || r["Meeting Type"] || "Internal",
          status: r.status || r.Status || "Scheduled",
          tenant_id: tenantId,
        };
      })
      .filter(Boolean);

    const skipped = rowsRaw.length - rows.length;
    if (rows.length === 0) {
      return res.status(400).json({ message: "No rows had the required Topic, Agenda, and Date columns." });
    }

    const created = await Meeting.insertMany(rows);
    res.status(201).json({ count: created.length, skipped, unmatchedMembers });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// AI Meeting Scribe — closes out a meeting: turns the full live transcript
// into a structured, bilingual (Hindi + English) meeting record.
exports.summarizeMeeting = async (req, res) => {
  try {
    const { transcript } = req.body;
    if (!transcript || !transcript.trim()) {
      return res.status(400).json({ message: "Meeting transcript is empty or missing." });
    }

    const meeting = await findTenantMeeting(req, req.params.id);
    if (!meeting) {
      return res.status(404).json({ message: "Meeting not found" });
    }

    let data;
    try {
      const agentName = await getAiAgentName(req.user?.tenant_id);
      const response = await aiClient.messages.create({
        model: AI_MODEL,
        max_tokens: 2048,
        system: SCRIBE_CLOSE_SYSTEM_PROMPT(meeting, agentName),
        messages: [{ role: "user", content: `Full transcript:\n${transcript}` }],
      });
      const text = response.content.find((b) => b.type === "text")?.text || "{}";
      data = parseJsonReply(text);
    } catch (aiErr) {
      // Fallback if the AI call fails or the key is missing — keep the meeting usable.
      console.error("CRM Agent Scribe summarizeMeeting AI call failed:", aiErr);
      data = {
        summary_hi: `"${meeting.topic}" meeting का transcript record हुआ, पर AI summary generate नहीं हो सका।`,
        summary_en: `Transcript recorded for "${meeting.topic}", but the AI summary could not be generated.`,
        agenda: [],
        decisions: [],
        action_items: [],
        open_questions_hi: [],
        crm_updates_suggested: [],
        needs_review: [`AI summarization failed: ${aiErr.message}`],
      };
    }

    meeting.summary = data.summary_hi || "";
    meeting.summary_en = data.summary_en || "";
    meeting.scribe_data = data;
    await meeting.save();
    await meeting.populate("members", MEMBER_FIELDS);

    logActivity(req, `AI Scribe summarized meeting: ${meeting.topic}`, { rel_id: meeting._id, rel_type: "meeting" });
    res.json(meeting);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Shared by scribeTurn and scribeDiagnostic — runs one system-prompt +
// transcript turn through Claude, resolving any CRM tool calls along the way,
// and returns the parsed JSON verdict. `tools` defaults to the read-only set —
// Scribe should never be handed create/update/delete/navigate during a live call.
const runScribeConversation = async (systemPrompt, userContent, req, tools = SCRIBE_READ_ONLY_TOOLS) => {
  const messages = [{ role: "user", content: userContent }];
  let response = await aiClient.messages.create({
    model: AI_MODEL,
    max_tokens: 512,
    system: systemPrompt,
    tools,
    messages,
  });

  while (response.stop_reason === "tool_use") {
    messages.push({ role: "assistant", content: response.content });
    const { toolResults } = await runCrmTools(response.content, req);
    messages.push({ role: "user", content: toolResults });
    response = await aiClient.messages.create({
      model: AI_MODEL,
      max_tokens: 512,
      system: systemPrompt,
      tools,
      messages,
    });
  }

  const text = response.content.find((b) => b.type === "text")?.text || "";
  return parseJsonReply(text);
};

// CRM Agent Scribe — one live turn. No wake word: the frontend calls this on
// every fresh chunk of transcript (rate-limited + pre-filtered client-side)
// and the model decides "a": ans/clarify/none/silent/blocked/no_module itself,
// after picking the right module (RULE 1) and running the RULE 5 data checks.
exports.scribeTurn = async (req, res) => {
  try {
    const { recentTranscript, hasExternalParticipant, alreadyAnswered } = req.body;
    if (!recentTranscript || !recentTranscript.trim()) {
      return res.status(400).json({ message: "recentTranscript is required." });
    }

    const meeting = await findTenantMeeting(req, req.params.id, { populate: true });
    if (!meeting) return res.status(404).json({ message: "Meeting not found" });

    const participantsLabel = (meeting.members || [])
      .map((m) => `${m.firstname} ${m.lastname}${m.admin || m.is_superadmin ? " (admin)" : ""}`)
      .join(", ");

    const agentName = await getAiAgentName(req.user?.tenant_id);
    const systemPrompt = SCRIBE_LIVE_SYSTEM_PROMPT(meeting, !!hasExternalParticipant, participantsLabel, Array.isArray(alreadyAnswered) ? alreadyAnswered : [], agentName);

    let turn;
    try {
      turn = await runScribeConversation(systemPrompt, `Recent transcript:\n${recentTranscript}`, req);
    } catch (err) {
      turn = { a: "silent", r: "", mod: null, k: null, src: [], name: null, tier: null, conf: "low", is_repeat: false, x: `Scribe turn failed: ${err.message}` };
    }

    res.json(turn);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Records that the organizer confirmed participants were told the meeting
// would be recorded — required before uploadRecording accepts a file, and
// kept as an audit trail (who confirmed, when).
exports.setRecordingConsent = async (req, res) => {
  try {
    const { given } = req.body;
    const meeting = await findTenantMeeting(req, req.params.id);
    if (!meeting) return res.status(404).json({ message: "Meeting not found" });

    meeting.recording_consent = {
      given: !!given,
      by: req.user?._id,
      at: new Date(),
    };
    await meeting.save();
    res.json({ recording_consent: meeting.recording_consent });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Accepts one finished recording (audio or video, captured client-side via
// tab-share MediaRecorder) and stores it in S3 — never on local disk, never
// with a public URL. Refuses the upload unless consent was recorded first.
exports.uploadRecording = async (req, res) => {
  try {
    const meeting = await findTenantMeeting(req, req.params.id);
    if (!meeting) return res.status(404).json({ message: "Meeting not found" });

    if (!meeting.recording_consent?.given) {
      return res.status(400).json({ message: "Recording consent has not been recorded for this meeting." });
    }
    if (!req.file) {
      return res.status(400).json({ message: "No recording file uploaded." });
    }

    const type = req.body.type === "video" ? "video" : "audio";
    const extension = type === "video" ? "webm" : "webm";
    const key = await uploadMeetingRecording(meeting.tenant_id, meeting._id, req.file.buffer, req.file.mimetype, extension);

    meeting.recordings.push({
      key,
      type,
      duration_seconds: Number(req.body.duration_seconds) || undefined,
      size_bytes: req.file.size,
      uploaded_by: req.user?._id,
    });
    await meeting.save();
    await meeting.populate("members", MEMBER_FIELDS);

    logActivity(req, `Recording saved for meeting: ${meeting.topic}`, { rel_id: meeting._id, rel_type: "meeting" });
    res.status(201).json(meeting);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Returns a short-lived signed URL for one recording — the S3 key itself is
// never sent to the client directly.
exports.getRecordingUrl = async (req, res) => {
  try {
    const meeting = await findTenantMeeting(req, req.params.id);
    if (!meeting) return res.status(404).json({ message: "Meeting not found" });

    const recording = meeting.recordings.id(req.params.recordingId);
    if (!recording) return res.status(404).json({ message: "Recording not found" });

    const url = await getSignedPlaybackUrl(recording.key);
    res.json({ url, expiresInSeconds: 600 });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Permanent — deletes the file from S3 first, then drops the subdocument only
// if that succeeds, so a failed S3 delete never leaves the DB pointing at a
// key that's already gone (and vice versa: a DB save failure after a
// successful S3 delete just orphans the reference, which is harmless).
exports.deleteRecording = async (req, res) => {
  try {
    const meeting = await findTenantMeeting(req, req.params.id);
    if (!meeting) return res.status(404).json({ message: "Meeting not found" });

    const recording = meeting.recordings.id(req.params.recordingId);
    if (!recording) return res.status(404).json({ message: "Recording not found" });

    await deleteMeetingRecording(recording.key);

    recording.deleteOne();
    await meeting.save();
    await meeting.populate("members", MEMBER_FIELDS);

    logActivity(req, `Recording deleted for meeting: ${meeting.topic}`, { rel_id: meeting._id, rel_type: "meeting" });
    res.json(meeting);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Diagnostic mode — same tool access, but "stay_silent" isn't an option: every
// input gets an explicit verdict + reason. For manually testing a single line
// of speech (e.g. "why didn't it find Sharma?") without running a live meeting.
exports.scribeDiagnostic = async (req, res) => {
  try {
    const { text, alreadyAnswered } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ message: "text is required." });
    }

    const meeting = await findTenantMeeting(req, req.params.id, { populate: true });
    if (!meeting) return res.status(404).json({ message: "Meeting not found" });

    const participantsLabel = (meeting.members || [])
      .map((m) => `${m.firstname} ${m.lastname}${m.admin || m.is_superadmin ? " (admin)" : ""}`)
      .join(", ");

    const agentName = await getAiAgentName(req.user?.tenant_id);
    const systemPrompt = SCRIBE_DIAGNOSTIC_SYSTEM_PROMPT(meeting, participantsLabel, Array.isArray(alreadyAnswered) ? alreadyAnswered : [], agentName);

    let verdict;
    try {
      verdict = await runScribeConversation(systemPrompt, `INPUT TEXT: ${text}`, req);
    } catch (err) {
      verdict = {
        verdict: "data_wrong",
        reply_hi: null,
        reason: `AI response was not valid JSON: ${err.message}`,
        answer_key: null,
        had_question_word: /[?？]/.test(text),
        name_heard: null,
        name_searched: null,
        records_found: 0,
        confidence: "low",
      };
    }

    res.json(verdict);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

