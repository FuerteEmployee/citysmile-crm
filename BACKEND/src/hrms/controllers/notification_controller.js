const Notification = require("../models/notification_model");

const currentUserId = (req) => req.user && (req.user.userId || req.user.id || req.user._id);

exports.getMyNotifications = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const skip = (page - 1) * limit;
    const userId = currentUserId(req);

    const filter = { userId };
    if (req.query.unread === "true") filter.isRead = false;

    const [data, total] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Notification.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      count: data.length,
      total,
      data,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getUnreadCount = async (req, res) => {
  try {
    const userId = currentUserId(req);
    const count = await Notification.countDocuments({ userId, isRead: false });
    res.status(200).json({ success: true, count });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.markRead = async (req, res) => {
  try {
    const userId = currentUserId(req);
    const n = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId },
      { isRead: true, readAt: new Date() },
      { returnDocument: "after" }
    );
    if (!n) return res.status(404).json({ success: false, message: "Notification not found" });
    res.status(200).json({ success: true, data: n });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.markAllRead = async (req, res) => {
  try {
    const userId = currentUserId(req);
    await Notification.updateMany({ userId, isRead: false }, { isRead: true, readAt: new Date() });
    res.status(200).json({ success: true, message: "All notifications marked read" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
