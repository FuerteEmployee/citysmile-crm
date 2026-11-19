const SalaryTemplate = require("../models/salary_template_model");
const cloudinary = require("cloudinary").v2;

async function processTemplateImages(templateData) {
  if (
    !process.env.CLOUDINARY_CLOUD_NAME ||
    !process.env.CLOUDINARY_API_KEY ||
    !process.env.CLOUDINARY_API_SECRET
  ) {
    return; // Cannot upload to Cloudinary without config
  }

  // Ensure cloudinary is configured
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  if (templateData.companyLogoUrl && templateData.companyLogoUrl.startsWith("data:image")) {
    try {
      const uploadRes = await cloudinary.uploader.upload(templateData.companyLogoUrl, {
        folder: "salary_templates",
      });
      templateData.companyLogoUrl = uploadRes.secure_url;
    } catch (e) {
      console.error("Cloudinary upload error (companyLogoUrl):", e);
    }
  }

  if (templateData.bgImage && templateData.bgImage.startsWith("data:image")) {
    try {
      const uploadRes = await cloudinary.uploader.upload(templateData.bgImage, {
        folder: "salary_templates",
      });
      templateData.bgImage = uploadRes.secure_url;
    } catch (e) {
      console.error("Cloudinary upload error (bgImage):", e);
    }
  }

  if (templateData.elements && Array.isArray(templateData.elements)) {
    for (let i = 0; i < templateData.elements.length; i++) {
      const el = templateData.elements[i];
      if (el.type === "image" && el.src && el.src.startsWith("data:image")) {
        try {
          const uploadRes = await cloudinary.uploader.upload(el.src, {
            folder: "salary_templates",
          });
          el.src = uploadRes.secure_url;
        } catch (e) {
          console.error("Cloudinary upload error (element image):", e);
        }
      }
    }
  }

  // Replace any base64 image src attributes embedded inside the HTML template string.
  // These come from <img src="data:image/..."> tags serialised by the canvas editor.
  // We must do this AFTER processing elements[] so the same base64 data
  // is deduplicated — if the element src was already replaced above, the
  // htmlTemplate still holds the old base64 string and needs its own upload.
  if (templateData.htmlTemplate && typeof templateData.htmlTemplate === "string") {
    // Match every  src="data:image/..."  occurrence (data URIs can be large)
    const BASE64_SRC = /src="(data:image\/[^;]+;base64,[^"]+)"/g;
    const seen = new Map(); // avoid re-uploading identical blobs

    let match;
    const toReplace = [];
    const regex = new RegExp(BASE64_SRC.source, "g");
    while ((match = regex.exec(templateData.htmlTemplate)) !== null) {
      const b64 = match[1];
      if (!seen.has(b64)) seen.set(b64, null);
      toReplace.push(b64);
    }

    // Upload unique blobs
    for (const [b64] of seen) {
      try {
        const uploadRes = await cloudinary.uploader.upload(b64, {
          folder: "salary_templates",
        });
        seen.set(b64, uploadRes.secure_url);
      } catch (e) {
        console.error("Cloudinary upload error (htmlTemplate img):", e);
      }
    }

    // Replace all occurrences in the HTML string
    for (const [b64, url] of seen) {
      if (url) {
        // Use split/join to avoid regex escape issues with base64 characters
        templateData.htmlTemplate = templateData.htmlTemplate.split(b64).join(url);
      }
    }
  }
}

// ─── Immediate single-image upload ───────────────────────────────────────────
// Called by the canvas editor as soon as the user picks a file so the
// Cloudinary URL is stored in the element — no base64 ever reaches MongoDB.

exports.uploadImage = async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64 || !imageBase64.startsWith("data:image")) {
      return res.status(400).json({ success: false, message: "imageBase64 is required" });
    }

    if (
      !process.env.CLOUDINARY_CLOUD_NAME ||
      !process.env.CLOUDINARY_API_KEY ||
      !process.env.CLOUDINARY_API_SECRET
    ) {
      return res.status(503).json({ success: false, message: "Cloudinary not configured on server" });
    }

    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });

    const uploadRes = await cloudinary.uploader.upload(imageBase64, {
      folder: "salary_templates",
    });

    res.status(200).json({ success: true, url: uploadRes.secure_url });
  } catch (error) {
    console.error("uploadImage error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getAll = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const templates = await SalaryTemplate.find(tenantFilter).sort({ isDefault: -1, createdAt: -1 });
    res.status(200).json({ success: true, data: templates });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getDefault = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const template = await SalaryTemplate.findOne({ isDefault: true, ...tenantFilter });
    if (!template)
      return res.status(404).json({ success: false, message: "No default template configured" });
    res.status(200).json({ success: true, data: template });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getById = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const template = await SalaryTemplate.findOne({ _id: req.params.id, ...tenantFilter });
    if (!template)
      return res.status(404).json({ success: false, message: "Template not found" });
    res.status(200).json({ success: true, data: template });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.create = async (req, res) => {
  try {
    const { isDefault, ...rest } = req.body;
    const tenant_id = req.user?.is_superadmin ? (req.body.tenant_id || null) : (req.user?.tenant_id || null);

    if (isDefault) {
      await SalaryTemplate.updateMany({ isDefault: true, tenant_id }, { isDefault: false });
    }

    await processTemplateImages(rest);

    const template = new SalaryTemplate({ ...rest, isDefault: !!isDefault, tenant_id });
    await template.save();
    res.status(201).json({ success: true, data: template });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "Template name already exists. Please choose a different name." });
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.update = async (req, res) => {
  try {
    const { isDefault, ...rest } = req.body;
    delete rest.tenant_id; // never reassignable via this endpoint
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };

    if (isDefault) {
      await SalaryTemplate.updateMany(
        { isDefault: true, _id: { $ne: req.params.id }, ...tenantFilter },
        { isDefault: false }
      );
    }

    await processTemplateImages(rest);

    const template = await SalaryTemplate.findOneAndUpdate(
      { _id: req.params.id, ...tenantFilter },
      { ...rest, isDefault: !!isDefault },
      { new: true, runValidators: true }
    );

    if (!template)
      return res.status(404).json({ success: false, message: "Template not found" });
    res.status(200).json({ success: true, data: template });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "Template name already exists. Please choose a different name." });
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const template = await SalaryTemplate.findOneAndDelete({ _id: req.params.id, ...tenantFilter });
    if (!template)
      return res.status(404).json({ success: false, message: "Template not found" });
    res.status(200).json({ success: true, message: "Template deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── AI Slip Analyzer ─────────────────────────────────────────────────────────

const { generateJson, AIProviderError } = require("../../services/geminiClient");

exports.analyzeSlipImage = async (req, res) => {
  try {
    const { imageBase64 } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ success: false, message: "imageBase64 is required" });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({ success: false, message: "GEMINI_API_KEY not configured on server" });
    }


    // Parse base64 data and mimeType
    let base64Data = imageBase64;
    let mimeType = "image/jpeg";
    if (imageBase64.startsWith("data:image")) {
      const parts = imageBase64.split(",");
      mimeType = parts[0].split(":")[1].split(";")[0];
      base64Data = parts[1];
    }

    const PROMPT = `You are a salary slip canvas template builder. Analyze this salary slip image and recreate its layout as JSON canvas elements.

The canvas is exactly 794px wide × 1123px tall (A4 portrait). Left/right margin: 32px (so content width = 730px).

Carefully identify every visual section in the salary slip and map each to one of these element types:
- "companyHeader" — top logo/company name/title/period band
- "infoGrid"       — employee details grid (name, ID, department, designation, DOJ, pay period, etc.)
- "earningsTable"  — earnings breakdown table
- "deductionsTable"— deductions breakdown table
- "netPayBar"      — net/take-home pay highlight band
- "attendanceGrid" — attendance summary (present/absent/leave/OT days)
- "bankGrid"       — bank account details
- "divider"        — horizontal rule line (height: 2)
- "text"           — standalone text (use "content" field for the actual visible text)
- "heading"        — section heading text
- "rect"           — decorative colored rectangle/band
- "signatureLine"  — signature area

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "canvasBg": "#hexcolor",
  "elements": [
    {
      "type": "string (one of the types above)",
      "x": number,
      "y": number,
      "width": number,
      "height": number,
      "content": "actual text if type is text/heading",
      "extraData": {
        "companyName": "Company Name Here",
        "companyAddress": "Address · Phone"
      },
      "style": {
        "backgroundColor": "#hex",
        "color": "#hex",
        "fontSize": number,
        "fontWeight": "bold or normal",
        "borderColor": "#hex",
        "borderWidth": number,
        "borderRadius": number,
        "paddingTop": number,
        "paddingLeft": number,
        "paddingRight": number,
        "paddingBottom": number,
        "textAlign": "left or center or right"
      }
    }
  ]
}

Critical rules:
1. Extract EXACT hex colors from the image — match the dominant header/brand color precisely
2. Position elements to faithfully match the visual layout proportions (scale to 794×1123)
3. For earningsTable + deductionsTable: place side-by-side (x=32 and x=407, width=355 each)
4. For companyHeader: x=0, y=0, width=794, extract background color from the header band
5. Include all visible sections as separate elements
6. If the company name text is visible, put it in extraData.companyName
7. Maintain vertical order top-to-bottom with accurate y positions and heights
8. Return ONLY the raw JSON object — nothing else`;

    let parsed;
    try {
      parsed = await generateJson({
        parts: [
          { text: PROMPT },
          { inlineData: { mimeType, data: base64Data } }
        ],
      });
    } catch (aiErr) {
      console.error("analyzeSlipImage AI call failed:", aiErr.message);
      return res.status(aiErr instanceof AIProviderError && aiErr.status === 503 ? 503 : 500).json({
        success: false,
        message: "AI could not generate a valid layout. Try with a clearer image.",
      });
    }

    const uid = (i) => `ai_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 5)}`;
    const elements = (parsed.elements || []).map((el, i) => ({
      elId: uid(i),
      zIndex: i + 1,
      locked: false,
      extraData: {},
      ...el,
    }));

    res.status(200).json({
      success: true,
      data: { elements, canvasBg: parsed.canvasBg || "#ffffff" },
    });
  } catch (error) {
    console.error("analyzeSlipImage error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to analyze image" });
  }
};
