const axios = require('axios');
const token = 'EAAS9qqymG74BSF8Rrg3He2uZA7l6WLKF9kV5gv0B10zAob9syCasylhG16Hh1zHbEaoi2OIDyzzeHKxeN1RT914OtkZBzE2gmhqG6ZAv4NJtDUZC3pm9tdbAjchk9BWmM2tjZAXW3wseJq11cR4RjIGke9aD3kNS4R9UimrwzISuIrsp7VOeflqzIrTfjzCloBcss2RAiGK2sbYMJwiCv02E1g13jFqdZCIKtm83VtyBmzpfUAU4z72xfLjEwlZA3VZAZC9m68qcdtOl5JIfGHEp8GgZDZD';

async function test() {
  try {
    console.log(`Trying to subscribe page using POST /me/subscribed_apps`);
    const subRes = await axios.post(`https://graph.facebook.com/v19.0/me/subscribed_apps`, 
      { subscribed_fields: 'leadgen' },
      { params: { access_token: token } }
    );
    console.log('✅ Subscribe Result:', subRes.data);
  } catch (err) {
    console.log('❌ Error:', err.response ? err.response.data : err.message);
  }
}

test();
