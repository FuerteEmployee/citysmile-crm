require("dotenv").config();
const mongoose = require("mongoose");

async function check() {
  await mongoose.connect(process.env.MONGO_URI);
  const Staff = require("./src/models/Staff");
  const all = await Staff.find({}).select("email admin tenant_id role firstname lastname");
  console.log("All staff:");
  all.forEach(s => console.log(` - ${s.email} | admin:${s.admin} | tenant_id:${s.tenant_id} | role:${s.role}`));
  await mongoose.disconnect();
}
check().catch(console.error);
