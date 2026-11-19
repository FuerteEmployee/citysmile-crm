const axios = require("axios");

async function run() {
  try {
    // We don't have a guaranteed login, so we will bypass auth by mocking it in the backend, or we can just send the request
    // Wait, let's just make a user in DB, or use the token from the user if we knew it.
    // Let's create a user and login
    const mongoose = require("mongoose");
    await mongoose.connect("mongodb://localhost:27017/ivougue");
    const Staff = require("./src/models/Staff");
    
    // find any staff
    const admin = await Staff.findOne({});
    if (!admin) {
      console.log("No staff found");
      process.exit(1);
    }
    
    // manually generate token
    const jwt = require("jsonwebtoken");
    const token = jwt.sign({ id: admin._id }, process.env.JWT_SECRET || "fallbacksecret", { expiresIn: "30d" });

    // Send request
    console.log("Sending POST to /api/leads");
    const payload = {
      "status": "", "source": "", "assigned": "", "tags": "", "name": "Test", 
      "position": "", "email": "", "website": "", "phonenumber": "", "lead_value": "", 
      "company": "", "address": "", "city": "", "state": "", "country": "", "zip": "", 
      "default_language": "English", "description": "", "is_public": false, "contacted_today": false
    };

    const res = await axios.post("http://localhost:5001/api/leads", payload, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log("Success:", res.data);
  } catch (err) {
    if (err.response) {
      console.error("HTTP Error:", err.response.data);
    } else {
      console.error("Error:", err.message);
    }
  }
  process.exit(0);
}
run();
