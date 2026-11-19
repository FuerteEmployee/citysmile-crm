const { ChatConversation, ChatMessage } = require("../models/ChatMessage");
const Staff = require("../models/Staff");

// @desc    Send a message
// @route   POST /api/chat/send
// @access  Private/Staff
exports.sendChatMessage = async (req, res) => {
  try {
    const { receiverId, message, isGroup } = req.body;
    const senderId = req.user._id;

    if (!receiverId || !message) {
      return res.status(400).json({ message: "Recipient and message are required" });
    }

    let conversation;
    if (isGroup) {
      conversation = await ChatConversation.findById(receiverId);
      if (!conversation) return res.status(404).json({ message: "Group not found" });

      conversation.lastMessage = { content: message, sender: senderId, timestamp: new Date() };
      await conversation.save();
    } else {
      // 1-Step optimized upsert for fast sending in production
      conversation = await ChatConversation.findOneAndUpdate(
        {
          isGroup: false,
          $or: [
            { participants: [senderId, receiverId] },
            { participants: [receiverId, senderId] }
          ]
        },
        {
          $set: {
            "lastMessage.content": message,
            "lastMessage.sender": senderId,
            "lastMessage.timestamp": new Date()
          },
          $setOnInsert: {
            participants: [senderId, receiverId]
          }
        },
        { new: true, upsert: true }
      );
    }

    // Create the message document natively (optimized to 1 row per msg)
    const chatMsg = await ChatMessage.create({
      conversationId: conversation._id,
      sender: senderId,
      receiver: isGroup ? undefined : receiverId,
      content: message,
      readBy: [senderId],
    });

    const io = req.app.get('io');
    if (io) {
      const payload = {
        _id: chatMsg._id,
        message: chatMsg.content,
        createdAt: chatMsg.createdAt,
        read: chatMsg.read,
        conversationId: conversation._id,
        isGroup,
        sender: {
          _id: senderId,
          firstname: req.user.firstname,
          lastname: req.user.lastname
        }
      };

      if (isGroup) {
        conversation.participants.forEach(p => {
          if (p.toString() !== senderId.toString()) {
            io.to(p.toString()).emit("newMessage", payload);
          }
        });
      } else {
        io.to(receiverId.toString()).emit("newMessage", payload);
      }
    }

    res.status(201).json({
      _id: chatMsg._id,
      message: chatMsg.content,
      createdAt: chatMsg.createdAt,
      read: chatMsg.read,
      conversationId: conversation._id,
      sender: {
        _id: senderId,
        firstname: req.user.firstname,
        lastname: req.user.lastname
      }
    });
  } catch (error) {
    console.error("Send message error:", error);
    res.status(500).json({ message: "Server error while sending message" });
  }
};

// @desc    Get chat history between current user and another staff
// @route   GET /api/chat/history/:userId
// @access  Private/Staff
exports.getChatHistory = async (req, res) => {
  try {
    const otherUserId = req.params.userId;
    const myId = req.user._id;
    const { before, after, limit = 50, isGroup } = req.query;

    let conversation;
    if (isGroup === "true") {
      conversation = await ChatConversation.findById(otherUserId).lean();
    } else {
      conversation = await ChatConversation.findOne({
        isGroup: false,
        $or: [
          { participants: [myId, otherUserId] },
          { participants: [otherUserId, myId] }
        ]
      }).lean();
    }

    if (!conversation) return res.json([]);

    // Query messages using native conversationId index
    const query = { conversationId: conversation._id };
    if (before && before !== "undefined") {
      query.createdAt = { $lt: new Date(before) };
    }
    if (after && after !== "undefined") {
      query.createdAt = { $gt: new Date(after) };
    }

    // Mark as read natively
    if (isGroup === "true") {
      ChatMessage.updateMany(
        { conversationId: conversation._id, readBy: { $ne: myId } },
        { $push: { readBy: myId } }
      ).catch(err => console.error("Update group read status error:", err));
    } else {
      ChatMessage.updateMany(
        { conversationId: conversation._id, receiver: myId, read: false },
        { $set: { read: true } }
      ).then((result) => {
        if (result.modifiedCount > 0) {
          const io = req.app.get('io');
          if (io) {
            io.to(otherUserId.toString()).emit("messagesRead", myId);
          }
        }
      }).catch(err => console.error("Update read status error:", err));
    }

    // Fetch raw documents
    const messages = await ChatMessage.find(query)
      .sort({ createdAt: after ? 1 : -1 })
      .limit(parseInt(limit))
      .populate("sender", "firstname lastname email")
      .lean();

    const mapped = messages.map(m => ({
      _id: m._id,
      message: m.content,
      createdAt: m.createdAt,
      sender: m.sender,
      read: m.read
    }));

    if (!after) mapped.reverse();

    res.json(mapped);
  } catch (error) {
    console.error("Get history error:", error);
    res.status(500).json({ message: "Server error while fetching history" });
  }
};

// @desc    Create a group chat
// @route   POST /api/chat/group
// @access  Private/Staff
exports.createGroupChat = async (req, res) => {
  try {
    const { groupName, participants } = req.body;
    const myId = req.user._id;

    if (!groupName || !participants || participants.length === 0) {
      return res.status(400).json({ message: "Group name and participants are required" });
    }

    const allParticipants = [...new Set([...participants, myId.toString()])];

    const group = await ChatConversation.create({
      isGroup: true,
      groupName,
      groupAdmin: myId,
      participants: allParticipants
    });

    res.status(201).json(group);
  } catch (error) {
    console.error("Create group error:", error);
    res.status(500).json({ message: "Server error creating group" });
  }
};

// @desc    Add member to group chat
// @route   PUT /api/chat/group/:groupId/add
// @access  Private/Staff
exports.addGroupMember = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { userId } = req.body;
    const myId = req.user._id;

    const group = await ChatConversation.findById(groupId);
    if (!group || !group.isGroup) return res.status(404).json({ message: "Group not found" });

    if (group.groupAdmin.toString() !== myId.toString() && !req.user.admin) {
      return res.status(403).json({ message: "Only group admin can add members" });
    }

    if (!group.participants.includes(userId)) {
      group.participants.push(userId);
      await group.save();
    }

    res.json(group);
  } catch (error) {
    console.error("Add member error:", error);
    res.status(500).json({ message: "Server error adding member" });
  }
};

// @desc    Get all staff members for chat contacts
// @route   GET /api/chat/staff
// @access  Private/Staff
exports.getChatStaff = async (req, res) => {
  try {
    const myId = req.user._id;
    const tenantId = req.user.tenant_id;

    // Scope to the current admin's tenant so cross-tenant staff never appear in chat.
    const staffQuery = { _id: { $ne: myId }, active: true };
    if (tenantId) {
      staffQuery.tenant_id = tenantId;
    } else if (!req.user.is_superadmin) {
      // No tenant and not super admin — return nothing
      return res.json([]);
    }

    const staff = await Staff.find(staffQuery)
      .select("firstname lastname email admin")
      .sort({ firstname: 1 });

    const groups = await ChatConversation.find({
      isGroup: true,
      participants: myId
    }).lean();

    const staffWithLastMessage = await Promise.all(
      staff.map(async (s) => {
        const conversation = await ChatConversation.findOne({
          isGroup: false,
          $or: [
            { participants: [myId, s._id] },
            { participants: [s._id, myId] }
          ]
        }).lean();

        const unreadCount = conversation ? await ChatMessage.countDocuments({
          conversationId: conversation._id,
          receiver: myId,
          read: false
        }) : 0;

        return {
          ...s.toObject(),
          isGroup: false,
          lastMessage: conversation?.lastMessage?.content || null,
          lastMessageTime: conversation?.lastMessage?.timestamp || null,
          unreadCount,
        };
      })
    );

    const groupsWithLastMessage = await Promise.all(
      groups.map(async (g) => {
        const unreadCount = await ChatMessage.countDocuments({
          conversationId: g._id,
          readBy: { $ne: myId }
        });

        return {
          _id: g._id,
          isGroup: true,
          firstname: g.groupName,
          lastname: "",
          email: "Group",
          admin: false,
          groupAdmin: g.groupAdmin,
          participants: g.participants,
          lastMessage: g.lastMessage?.content || null,
          lastMessageTime: g.lastMessage?.timestamp || null,
          unreadCount,
        };
      })
    );

    // Sort combined list by lastMessageTime descending
    const combined = [...groupsWithLastMessage, ...staffWithLastMessage].sort((a, b) => {
      const timeA = a.lastMessageTime ? new Date(a.lastMessageTime).getTime() : 0;
      const timeB = b.lastMessageTime ? new Date(b.lastMessageTime).getTime() : 0;
      return timeB - timeA;
    });

    res.json(combined);
  } catch (error) {
    console.error("Get chat staff error:", error);
    res.status(500).json({ message: "Server error while fetching contacts" });
  }
};

// @desc    Delete a message
// @route   DELETE /api/chat/message/:id
// @access  Private/Staff
exports.deleteChatMessage = async (req, res) => {
  try {
    const messageId = req.params.id;
    const userId = req.user._id;

    const deletedMsg = await ChatMessage.findOneAndDelete(
      { _id: messageId, sender: userId }
    );

    if (!deletedMsg) {
      return res.status(404).json({ message: "Message not found or unauthorized" });
    }

    const io = req.app.get("io");
    if (io) {
      const conversation = await ChatConversation.findById(deletedMsg.conversationId);
      if (conversation && conversation.participants) {
        conversation.participants.forEach(p => {
          io.to(p.toString()).emit("messageDeleted", messageId);
        });
      }
    }

    res.json({ message: "Message deleted successfully", id: messageId });
  } catch (error) {
    console.error("Delete message error:", error);
    res.status(500).json({ message: "Server error while deleting message" });
  }
};

// @desc    Mark chat messages as read
// @route   PUT /api/chat/read/:userId
// @access  Private/Staff
exports.markAsRead = async (req, res) => {
  try {
    const otherUserId = req.params.userId;
    const myId = req.user._id;
    const { isGroup } = req.body;

    let conversation;
    if (isGroup) {
      conversation = await ChatConversation.findById(otherUserId).lean();
    } else {
      conversation = await ChatConversation.findOne({
        isGroup: false,
        $or: [
          { participants: [myId, otherUserId] },
          { participants: [otherUserId, myId] }
        ]
      }).lean();
    }

    if (!conversation) return res.json({ success: true });

    let result;
    if (isGroup) {
      result = await ChatMessage.updateMany(
        { conversationId: conversation._id, readBy: { $ne: myId } },
        { $push: { readBy: myId } }
      );
    } else {
      result = await ChatMessage.updateMany(
        { conversationId: conversation._id, receiver: myId, read: false },
        { $set: { read: true } }
      );
    }

    if (!isGroup && result.modifiedCount > 0) {
      const io = req.app.get('io');
      if (io) io.to(otherUserId.toString()).emit("messagesRead", myId);
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Mark read error:", error);
    res.status(500).json({ message: "Server error marking read" });
  }
};

// @desc    Exit group chat
// @route   PUT /api/chat/group/:groupId/exit
// @access  Private/Staff
exports.exitGroupChat = async (req, res) => {
  try {
    const { groupId } = req.params;
    const myId = req.user._id;

    const group = await ChatConversation.findById(groupId);
    if (!group || !group.isGroup) return res.status(404).json({ message: "Group not found" });

    if (group.groupAdmin.toString() === myId.toString()) {
      return res.status(400).json({ message: "Group admin cannot exit. Delete the group instead." });
    }

    group.participants = group.participants.filter(p => p.toString() !== myId.toString());
    await group.save();

    res.json({ success: true, message: "Exited group" });
  } catch (error) {
    console.error("Exit group error:", error);
    res.status(500).json({ message: "Server error exiting group" });
  }
};

// @desc    Delete group chat
// @route   DELETE /api/chat/group/:groupId
// @access  Private/Staff
exports.deleteGroupChat = async (req, res) => {
  try {
    const { groupId } = req.params;
    const myId = req.user._id;

    const group = await ChatConversation.findById(groupId);
    if (!group || !group.isGroup) return res.status(404).json({ message: "Group not found" });

    if (group.groupAdmin.toString() !== myId.toString() && !req.user.admin) {
      return res.status(403).json({ message: "Only group admin can delete the group" });
    }

    await ChatConversation.findByIdAndDelete(groupId);
    await ChatMessage.deleteMany({ conversationId: groupId });

    res.json({ success: true, message: "Group deleted" });
  } catch (error) {
    console.error("Delete group error:", error);
    res.status(500).json({ message: "Server error deleting group" });
  }
};
