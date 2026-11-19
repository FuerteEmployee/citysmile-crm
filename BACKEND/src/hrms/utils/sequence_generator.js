const Counter = require("../models/counter_model");
const WarrantyTicket = require("../models/warranty_ticket_model");
const InstallationTicket = require("../models/installation_ticket_model");
const ServiceTicket = require("../models/service_ticket_model");

// Ticket collections numbered off a shared Counter. Each ticketNo is formatted
// `${root}-${year}${seq}` and the Counter is keyed `${root}-${year}` — e.g. the
// key "WRN-2026" drives "WRN-202600001". Registering the model here lets
// getNextSequence floor the counter to the highest number already present in the
// collection, so the counter can never lag behind real data and duplicate-key
// errors repair themselves. No manual counter-sync step is ever required.
const TICKET_MODELS = {
  WRN: WarrantyTicket,
  INS: InstallationTicket,
  TKT: ServiceTicket,
};

// Highest sequence already stored for a prefix — the drift-repair floor.
// ticketNo is unique-indexed and zero-padded, so a descending index scan yields
// the max in O(log n); the anchored `^prefix` regex keeps the scan index-bound.
async function highestStoredSeq(prefix, session) {
  const model = TICKET_MODELS[String(prefix).split("-")[0]];
  if (!model) return 0;

  const escaped = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(`^${escaped}(\\d+)$`);
  const last = await model
    .findOne({ ticketNo: rx })
    .select("ticketNo")
    .sort({ ticketNo: -1 })
    .session(session)
    .lean();

  const match = last && rx.exec(last.ticketNo || "");
  return match ? parseInt(match[1], 10) : 0;
}

async function getNextSequence(prefix, session = null) {
  const floor = await highestStoredSeq(prefix, session);

  // 1. Floor the counter to the highest number already stored ($max only raises,
  //    never lowers) — this repairs any drift and never reissues an existing seq.
  // 2. Atomically claim the next value. Both $max and $inc are atomic update
  //    operators, so concurrent callers still each get a distinct sequence.
  await Counter.updateOne(
    { _id: prefix },
    { $max: { seq: floor } },
    { upsert: true, session }
  );
  const counter = await Counter.findOneAndUpdate(
    { _id: prefix },
    { $inc: { seq: 1 } },
    { returnDocument: "after", session }
  );
  return counter.seq;
}

module.exports = { getNextSequence };
