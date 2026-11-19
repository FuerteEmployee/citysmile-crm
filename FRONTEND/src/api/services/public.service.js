import { apiClient } from "../client";

export const publicService = {
  // Active subscription plans for the in-app Subscription / renewal page.
  // (No self-service signup on this single-company CRM.)
  getPlans: async () => {
    const response = await apiClient.get("/public/plans");
    return Array.isArray(response) ? response : [];
  },
};
