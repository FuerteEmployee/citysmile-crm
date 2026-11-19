const mongoose = require("mongoose");
const Lead = require("./src/models/Lead");

async function test() {
  await mongoose.connect("mongodb://localhost:27017/ivougue", {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });

  const payload = {
    "status": "", "source": "", "assigned": "", "tags": "", "name": "", 
    "position": "", "email": "", "website": "", "phonenumber": "", "lead_value": "", 
    "company": "", "address": "", "city": "", "state": "", "country": "", "zip": "", 
    "default_language": "English", "description": "", "is_public": false, "contacted_today": false
  };

  const { custom_fields, ...leadData } = payload;
    
  if (leadData.status === "") delete leadData.status;
  if (leadData.source === "") delete leadData.source;
  if (leadData.assigned === "") delete leadData.assigned;
  if (leadData.addedfrom === "") delete leadData.addedfrom;

  console.log("Cleaned Lead Data:", leadData);

  try {
    const lead = await Lead.create(leadData);
    console.log("Success:", lead);
  } catch (err) {
    console.error("Error creating lead:", err.message);
  }

  process.exit(0);
}

test();
