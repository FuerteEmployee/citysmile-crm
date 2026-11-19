const CustomField = require("../models/CustomField");
const CustomFieldValue = require("../models/CustomFieldValue");

/**
 * Service to handle custom field logic
 */
class CustomFieldService {
  /**
   * Query filter for the custom fields a company can see: its own fields plus
   * legacy fields that have no owner yet (tenant_id null, from before fields
   * were per-company). No tenantId (super admin / not passed) = no filter.
   * @param {string|ObjectId|null} tenantId
   * @returns {Object}
   */
  static tenantScope(tenantId) {
    return tenantId ? { tenant_id: { $in: [tenantId, null] } } : {};
  }

  /**
   * Get all custom fields for a specific entity type
   * @param {string} fieldto - Entity type (e.g. 'customers', 'staff')
   * @param {string|ObjectId|null} tenantId - Company the fields belong to
   * @returns {Promise<Array>}
   */
  static async getFieldsFor(fieldto, tenantId = null) {
    return await CustomField.find({ fieldto, active: true, ...this.tenantScope(tenantId) }).sort({ field_order: 1 });
  }

  /**
   * Find one field by slug for a company, preferring the company's own field
   * over a legacy unowned one with the same slug.
   */
  static async findBySlug(slug, fieldto, tenantId = null) {
    const matches = await CustomField.find({ slug, fieldto, ...this.tenantScope(tenantId) });
    return matches.find((f) => f.tenant_id) || matches[0] || null;
  }

  /**
   * Get custom field values for a specific entity instance
   * @param {string} relid - ID of the entity instance
   * @param {string} fieldto - Entity type
   * @returns {Promise<Object>} - Map of field slug to value
   */
  static async getValues(relid, fieldto) {
    const values = await CustomFieldValue.find({ relid, fieldto }).populate("fieldid");
    const result = {};
    values.forEach((v) => {
      if (v.fieldid) {
        result[v.fieldid.slug] = v.value;
      }
    });
    return result;
  }

  /**
   * Batch version of getValues — one query for every record instead of one
   * query per record, so list pages don't fire an extra DB round-trip per row.
   * @param {string[]} relids - IDs of the entity instances
   * @param {string} fieldto - Entity type
   * @returns {Promise<Map<string, Object>>} - relid (string) -> map of field slug to value
   */
  static async getValuesForMany(relids, fieldto) {
    const result = new Map();
    if (!relids || relids.length === 0) return result;

    const values = await CustomFieldValue.find({ relid: { $in: relids }, fieldto }).populate("fieldid");
    values.forEach((v) => {
      if (!v.fieldid) return;
      const key = String(v.relid);
      if (!result.has(key)) result.set(key, {});
      result.get(key)[v.fieldid.slug] = v.value;
    });
    return result;
  }

  /**
   * Delete all custom field values for a specific entity instance (called
   * when the entity itself — e.g. an invoice — is deleted, so its custom
   * field rows don't linger orphaned in the collection).
   * @param {string} relid - ID of the entity instance
   * @param {string} fieldto - Entity type
   */
  static async deleteValues(relid, fieldto) {
    await CustomFieldValue.deleteMany({ relid, fieldto });
  }

  /**
   * Batch version of deleteValues — one query for every record instead of
   * one query per record (used by bulk-delete endpoints).
   * @param {string[]} relids - IDs of the entity instances
   * @param {string} fieldto - Entity type
   */
  static async deleteValuesForMany(relids, fieldto) {
    if (!relids || relids.length === 0) return;
    await CustomFieldValue.deleteMany({ relid: { $in: relids }, fieldto });
  }

  /**
   * Handle custom fields POST data
   * @param {string} relid - ID of the entity instance
   * @param {string} fieldto - Entity type
   * @param {Object} customFieldsData - Map of field slug/ID to value
   * @param {string|ObjectId|null} tenantId - Company of the record; fields of
   *   other companies are ignored so a record can't write into them
   */
  static async handlePost(relid, fieldto, customFieldsData, tenantId = null) {
    if (!customFieldsData || typeof customFieldsData !== "object") return;

    for (const [key, value] of Object.entries(customFieldsData)) {
      // Find the field definition
      let field;
      if (key.match(/^[0-9a-fA-F]{24}$/)) {
        field = await CustomField.findOne({ _id: key, fieldto, ...this.tenantScope(tenantId) });
      } else {
        field = await this.findBySlug(key, fieldto, tenantId);
      }

      if (field) {
        await CustomFieldValue.findOneAndUpdate(
          { fieldid: field._id, relid, fieldto },
          { value },
          { upsert: true, new: true }
        );
      }
    }
  }
}

module.exports = CustomFieldService;
