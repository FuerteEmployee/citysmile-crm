const Announcement = require("../models/Announcement");

const announcementScope = (req) => {
  const filter = { _id: req.params.id };
  if (!req.user?.is_superadmin && req.user?.tenant_id) {
    filter.tenant_id = req.user.tenant_id;
  }
  return filter;
};

const getAnnouncements = async (req, res) => {
  try {
    const filter = { $or: [{ showtostaff: true }, { showtousers: true }] };
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;
    const announcements = await Announcement.find(filter).sort({ dateadded: -1 });
    res.json(announcements);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createAnnouncement = async (req, res) => {
  try {
    const announcement = await Announcement.create({
      ...req.body,
      userid: req.user._id,
      tenant_id: req.user?.tenant_id,
    });
    res.status(201).json(announcement);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getAnnouncementById = async (req, res) => {
  try {
    const announcement = await Announcement.findOne(announcementScope(req));
    if (!announcement) return res.status(404).json({ message: "Announcement not found" });
    res.json(announcement);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateAnnouncement = async (req, res) => {
  try {
    const announcement = await Announcement.findOneAndUpdate(announcementScope(req), req.body, { new: true });
    if (!announcement) return res.status(404).json({ message: "Announcement not found" });
    res.json(announcement);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteAnnouncement = async (req, res) => {
  try {
    const announcement = await Announcement.findOneAndDelete(announcementScope(req));
    if (!announcement) return res.status(404).json({ message: "Announcement not found" });
    res.json({ message: "Announcement deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getAnnouncements, createAnnouncement, getAnnouncementById, updateAnnouncement, deleteAnnouncement };
