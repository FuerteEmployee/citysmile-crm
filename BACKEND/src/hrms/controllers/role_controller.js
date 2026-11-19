const Role = require("../models/role_model");

exports.createRole = async (req, res) => {
  try {
    const {
      role,
      label,
      description = "",
      icon = "Shield",
      color = "bg-primary/10 text-primary border-primary/20",
      permissions = [],
      attendanceRequired = true,
    } = req.body;

    if (!role || !label) {
      return res.status(400).json({
        message: "role and label are required",
      });
    }

    const tenant_id = req.user?.is_superadmin ? (req.body.tenant_id || null) : (req.user?.tenant_id || null);

    const existingRole = await Role.findOne({ role: role.toLowerCase(), tenant_id });
    if (existingRole) {
      return res.status(400).json({
        message: "Role key already exists",
      });
    }

    const newRole = await Role.create({
      role: role.toLowerCase().trim(),
      label: label.trim(),
      description,
      icon,
      color,
      permissions,
      attendanceRequired,
      tenant_id,
    });
    res.status(201).json(newRole);
  } catch (err) {
    res.status(500).json({
      message: "Error creating role",
      error: err.message,
    });
  }
};

exports.updateRole = async (req, res) => {
  try {
    const { role, label, description, icon, color, permissions, attendanceRequired } = req.body;
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };

    const existingRole = await Role.findOne({ _id: req.params.id, ...tenantFilter });
    if (!existingRole) {
      return res.status(404).json({ message: "Role not found" });
    }

    if (existingRole.isSystemRole) {
      return res.status(400).json({
        message: "Cannot edit system role",
      });
    }

    if (role && role !== existingRole.role) {
      const duplicate = await Role.findOne({
        role: role.toLowerCase(),
        _id: { $ne: req.params.id },
        ...tenantFilter,
      });

      if (duplicate) {
        return res.status(400).json({
          message: "Role key already exists",
        });
      }

      existingRole.role = role.toLowerCase().trim();
    }

    if (label !== undefined) existingRole.label = label.trim();
    if (description !== undefined) existingRole.description = description;
    if (icon !== undefined) existingRole.icon = icon;
    if (color !== undefined) existingRole.color = color;
    if (permissions !== undefined) existingRole.permissions = permissions;
    if (attendanceRequired !== undefined) existingRole.attendanceRequired = attendanceRequired;

    const updatedRole = await existingRole.save();

    res.json(updatedRole);
  } catch (err) {
    res.status(500).json({
      message: "Error updating role",
      error: err.message,
    });
  }
};

exports.deleteRole = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const role = await Role.findOne({ _id: req.params.id, ...tenantFilter });

    if (!role) {
      return res.status(404).json({ message: "Role not found" });
    }

    if (role.isSystemRole) {
      return res.status(400).json({
        message: "Cannot delete system role",
      });
    }

    await role.deleteOne();

    res.json({ message: "Role deleted" });
  } catch (err) {
    res.status(500).json({
      message: "Error deleting role",
      error: err.message,
    });
  }
};

exports.getRoles = async (req, res) => {
  try {
    const query = req.user?.is_superadmin
      ? { tenant_id: null }
      : { $or: [{ tenant_id: req.user?.tenant_id || null }, { isSystemRole: true }] };
    const roles = await Role.find(query).sort({ createdAt: 1 });
    res.json(roles);
  } catch (err) {
    res.status(500).json({
      message: "Error fetching roles",
      error: err.message,
    });
  }
};
