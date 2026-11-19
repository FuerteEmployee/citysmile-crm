const axios = require('axios');
const token = 'EAAS9qqymG74BSF8Rrg3He2uZA7l6WLKF9kV5gv0B10zAob9syCasylhG16Hh1zHbEaoi2OIDyzzeHKxeN1RT914OtkZBzE2gmhqG6ZAv4NJtDUZC3pm9tdbAjchk9BWmM2tjZAXW3wseJq11cR4RjIGke9aD3kNS4R9UimrwzISuIrsp7VOeflqzIrTfjzCloBcss2RAiGK2sbYMJwiCv02E1g13jFqdZCIKtm83VtyBmzpfUAU4z72xfLjEwlZA3VZAZC9m68qcdtOl5JIfGHEp8GgZDZD';

async function test() {
  try {
    const res = await axios.get('https://graph.facebook.com/v19.0/me', { params: { access_token: token } });
    console.log('Me API Response:');
    console.log(res.data);
    
    // Check if it's a user token that has accounts
    if (res.data.name && !res.data.category) {
      console.log('\nLooks like a User Token. Trying to fetch pages...');
      const pagesRes = await axios.get('https://graph.facebook.com/v19.0/me/accounts', { params: { access_token: token } });
      console.log('Pages:', pagesRes.data.data.map(p => `${p.name} (${p.id})`));
      
      // Let's try to subscribe the first page automatically!
      if (pagesRes.data.data.length > 0) {
        const page = pagesRes.data.data[0];
        console.log(`\nTrying to subscribe page: ${page.name}`);
        const subRes = await axios.post(`https://graph.facebook.com/v19.0/${page.id}/subscribed_apps`, 
          { subscribed_fields: 'leadgen' },
          { params: { access_token: page.access_token } }
        );
        console.log('Subscribe Result:', subRes.data);
        
        console.log(`\n✅ Successfully subscribed! New Page Token for .env:\n${page.access_token}`);
      }
    }
  } catch (err) {
    console.log('Error:', err.response ? err.response.data : err.message);
  }
}

test();
