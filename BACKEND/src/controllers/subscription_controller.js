const Subscription = require("../models/Subscription");

const tenantScope = (req) => {
  const filter = {};
  if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;
  return filter;
};

// Fields the form may not change (company, Stripe bookkeeping).
const cleanPayload = (body) => {
  const payload = { ...body };
  ["_id", "tenant_id", "stripe_plan_id", "stripe_subscription_id", "createdAt", "updatedAt"].forEach((k) => delete payload[k]);
  return payload;
};

const getSubscriptions = async (req, res) => {
  try {
    const subscriptions = await Subscription.find(tenantScope(req)).populate("client", "company");
    res.json(subscriptions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getSubscriptionById = async (req, res) => {
  try {
    const subscription = await Subscription.findOne({ _id: req.params.id, ...tenantScope(req) });
    if (!subscription) return res.status(404).json({ message: "Subscription not found" });
    res.json(subscription);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createSubscription = async (req, res) => {
  try {
    const subscription = await Subscription.create({ ...cleanPayload(req.body), tenant_id: req.user?.tenant_id });
    res.status(201).json(subscription);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateSubscription = async (req, res) => {
  try {
    const subscription = await Subscription.findOneAndUpdate(
      { _id: req.params.id, ...tenantScope(req) },
      cleanPayload(req.body),
      { new: true, runValidators: true }
    );
    if (!subscription) return res.status(404).json({ message: "Subscription not found" });
    res.json(subscription);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteSubscription = async (req, res) => {
  try {
    const subscription = await Subscription.findOneAndDelete({ _id: req.params.id, ...tenantScope(req) });
    if (subscription) {
      res.json({ message: "Subscription removed" });
    } else {
      res.status(404).json({ message: "Subscription not found" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getSubscriptions, getSubscriptionById, createSubscription, updateSubscription, deleteSubscription };
