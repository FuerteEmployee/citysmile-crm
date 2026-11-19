const connectDB = require('./src/config/db');
const MainSidebar = require('./src/models/MainSidebar');
const dotenv = require('dotenv');

dotenv.config();

async function cleanSidebar() {
  await connectDB();
  
  try {
    // 1. Find the manually added "HRMS" parent folder
    // The user's screenshot shows an "HRMS" folder with a dropdown arrow containing all the duplicates.
    const parentFolder = await MainSidebar.findOne({ title: "HRMS" });
    
    if (parentFolder) {
      console.log("Found HRMS parent folder. Deleting it and all its children...");
      // Delete all children of this folder
      const deletedChildren = await MainSidebar.deleteMany({ parent_id: parentFolder._id });
      console.log(`Deleted ${deletedChildren.deletedCount} children of HRMS folder.`);
      
      // Delete the folder itself
      await MainSidebar.deleteOne({ _id: parentFolder._id });
      console.log("Deleted HRMS parent folder.");
    } else {
      console.log("No HRMS parent folder found.");
    }

    // 2. The user also explicitly asked to remove "Dashboard" and "Departments"
    // from the HRMS items we added (group: Management or URL containing /hrms)
    console.log("Removing specific unused HRMS menus...");
    const d1 = await MainSidebar.deleteMany({ title: "HR Dashboard" });
    const d2 = await MainSidebar.deleteMany({ title: "Departments", url: { $regex: "/hrms" } });
    const d3 = await MainSidebar.deleteMany({ title: "Dashboard", url: { $regex: "/hrms" } });
    
    console.log(`Deleted ${d1.deletedCount} HR Dashboards.`);
    console.log(`Deleted ${d2.deletedCount} Departments.`);
    console.log(`Deleted ${d3.deletedCount} Dashboards.`);

    // 3. Just to be absolutely sure there are no other duplicates of Advance Salary:
    const advances = await MainSidebar.find({ title: "Advance Salary" });
    if (advances.length > 1) {
       for (let i = 1; i < advances.length; i++) {
          await MainSidebar.deleteOne({ _id: advances[i]._id });
          console.log("Deleted duplicate Advance Salary.");
       }
    }

    console.log("Cleanup completely finished! Please restart nodemon and refresh your browser.");
  } catch(e) {
    console.error(e);
  }
  
  process.exit(0);
}

cleanSidebar();
