const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

let storage;

if (
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
      folder: "screentime_docs",
      resource_type: "auto",
    },
  });
} else {
  // Ensure uploads directory exists
  const uploadDir = path.join(__dirname, "../../uploads");
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  storage = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
      cb(null, Date.now() + "-" + file.originalname);
    },
  });
}

const uploadMemory = multer({ storage: multer.memoryStorage() });

const uploadToCloudinary = (file, folder = "screentime_docs") => {
  return new Promise((resolve, reject) => {
    if (
      process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
    ) {
      if (file.buffer) {
        const stream = cloudinary.uploader.upload_stream(
          { folder, resource_type: "auto" },
          (error, result) => {
            if (error) return reject(error);
            resolve(result.secure_url || result.url);
          },
        );
        stream.end(file.buffer);
      } else if (file.path) {
        cloudinary.uploader.upload(
          file.path,
          { folder, resource_type: "auto" },
          (error, result) => {
            if (error) return reject(error);
            resolve(result.secure_url || result.url);
          },
        );
      } else {
        reject(new Error("No file buffer or path available"));
      }
    } else {
      // Local file fallback
      if (file.path) {
        const relativePath = file.path.includes("uploads")
          ? `/uploads/${file.path.split(/uploads[/\\]/).pop().replace(/\\/g, "/")}`
          : file.path;
        resolve(relativePath);
      } else if (file.buffer) {
        const uploadDir = path.join(__dirname, "../../uploads");
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }
        const localFileName =
          Date.now() + "-" + (file.originalname || "upload.jpg");
        const localFilePath = path.join(uploadDir, localFileName);
        fs.writeFileSync(localFilePath, file.buffer);
        // Return a relative path compatible with the application's local file serving
        resolve(`/uploads/${localFileName}`);
      } else {
        reject(new Error("No file buffer or path available"));
      }
    }
  });
};

const upload = multer({ storage: storage });
upload.uploadMemory = uploadMemory;
upload.uploadToCloudinary = uploadToCloudinary;

module.exports = upload;
