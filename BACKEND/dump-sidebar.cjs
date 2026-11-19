const mongoose = require('mongoose');
const MainSidebar = require('./src/models/MainSidebar');
const dotenv = require('dotenv');
dotenv.config();

async function dump() {
  await mongoose.connect(process.env.MONGO_URI);
  const items = await MainSidebar.find().lean();
  console.log(JSON.stringify(items, null, 2));
  process.exit(0);
}
dump().catch(console.error);
