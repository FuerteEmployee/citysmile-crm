const EstimateRequest = require("../models/EstimateRequest");
const EstimateRequestForm = require("../models/EstimateRequestForm");

// @desc    Get all estimate requests
// @route   GET /api/estimate-requests
// @access  Private
const getEstimateRequests = async (req, res) => {
  try {
    const requests = await EstimateRequest.find()
      .populate("form", "name")
      .populate("status", "name color")
      .populate("assigned", "firstname lastname")
      .sort({ createdAt: -1 });
    res.json(requests);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get single estimate request
// @route   GET /api/estimate-requests/:id
// @access  Private
const getEstimateRequestById = async (req, res) => {
  try {
    const request = await EstimateRequest.findById(req.params.id)
      .populate("form")
      .populate("status", "name color")
      .populate("assigned", "firstname lastname")
      .populate("converted_to_estimate", "number total status")
      .populate("converted_to_lead", "firstname lastname company");
    if (!request) return res.status(404).json({ message: "Request not found" });
    res.json(request);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update request status
// @route   PATCH /api/estimate-requests/:id/status
// @access  Private
const updateRequestStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const request = await EstimateRequest.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    ).populate("status", "name color");
    
    if (!request) return res.status(404).json({ message: "Request not found" });
    res.json(request);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Create estimate request (Internal)
// @route   POST /api/estimate-requests
// @access  Private
const createEstimateRequest = async (req, res) => {
  try {
    const request = new EstimateRequest(req.body);
    const savedRequest = await request.save();
    res.status(201).json(savedRequest);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Delete estimate request
// @route   DELETE /api/estimate-requests/:id
// @access  Private
const deleteEstimateRequest = async (req, res) => {
  try {
    const request = await EstimateRequest.findByIdAndDelete(req.params.id);
    if (!request) return res.status(404).json({ message: "Request not found" });
    res.json({ message: "Request deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update estimate request
// @route   PUT /api/estimate-requests/:id
// @access  Private
const updateEstimateRequest = async (req, res) => {
  try {
    const { status, assigned, firstname, lastname, email, phone, company, connectPerson, salesPerson, items, is_converted, converted_to_estimate } = req.body;
    const updateData = {};
    if (status !== undefined) updateData.status = status;
    if (assigned !== undefined) updateData.assigned = assigned;
    if (firstname !== undefined) updateData.firstname = firstname;
    if (lastname !== undefined) updateData.lastname = lastname;
    if (email !== undefined) updateData.email = email;
    if (phone !== undefined) updateData.phone = phone;
    if (company !== undefined) updateData.company = company;
    if (connectPerson !== undefined) updateData.connectPerson = connectPerson;
    if (salesPerson !== undefined) updateData.salesPerson = salesPerson;
    // Set together by EstimateCreate.tsx right after it successfully creates
    // the Estimate a "Convert to Estimate" click was seeded from.
    if (is_converted !== undefined) updateData.is_converted = is_converted;
    if (converted_to_estimate !== undefined) updateData.converted_to_estimate = converted_to_estimate;
    if (items !== undefined) {
      updateData.items = items.map(item => ({
        description: item.description || "",
        qty: Number(item.qty) || 0,
        rate: Number(item.rate) || 0,
        amount: (Number(item.qty) || 0) * (Number(item.rate) || 0)
      }));
    }

    const request = await EstimateRequest.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true }
    )
      .populate("form")
      .populate("status", "name color")
      .populate("assigned", "firstname lastname")
      .populate("converted_to_estimate", "number total status")
      .populate("converted_to_lead", "firstname lastname company");

    if (!request) return res.status(404).json({ message: "Request not found" });
    res.json(request);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

module.exports = {
  getEstimateRequests,
  getEstimateRequestById,
  updateRequestStatus,
  createEstimateRequest,
  deleteEstimateRequest,
  updateEstimateRequest,
};
