const axios = require('axios');

async function testRemote() {
  try {
    // 1. Log in
    const res = await axios.post('https://crm-backend-1-qurl.onrender.com/api/auth/login', {
      email: "admin@example.com", // Assuming this is an admin email? Or we can look in DB.
      password: "password123"
    });
    console.log(res.data);
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
  }
}
testRemote();
