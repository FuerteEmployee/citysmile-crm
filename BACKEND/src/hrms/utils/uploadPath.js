// Without Cloudinary, multer's disk storage reports file.path as an absolute
// disk path (e.g. "E:\...\src\uploads\123-photo.png"), which no browser can
// load. Store the "/uploads/<file>" URL index.js actually serves instead —
// same conversion cloudinary_config.uploadToCloudinary does for its local fallback.
// Cloudinary URLs (http...) pass through unchanged.
const toPublicUploadPath = (filePath) => {
  if (!filePath || typeof filePath !== "string" || /^https?:\/\//i.test(filePath)) return filePath;
  const match = filePath.split(/[/\\]uploads[/\\]/);
  if (match.length < 2) return filePath;
  return `/uploads/${match.pop().replace(/\\/g, "/")}`;
};

module.exports = { toPublicUploadPath };
