const connectDB = require('./src/config/db');
const MainSidebar = require('./src/models/MainSidebar');
const dotenv = require('dotenv');

dotenv.config();

async function check() {
  await connectDB();
  const items = await MainSidebar.find({}).sort({ order: 1 });
  console.log(items.map(i => `${i.title} | ${i.url} | ${i.group} | ${i.parent_id || 'root'}`).join('\n'));
  process.exit(0);
}

check();
