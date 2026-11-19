jest.mock("../../models/Client");
jest.mock("../../models/Contact");

const Client = require("../../models/Client");
const Contact = require("../../models/Contact");
const { findCustomersByPhone } = require("../callingAgentLookupService");

function mockClientFind(docs) {
  Client.find.mockReturnValue({ select: jest.fn().mockResolvedValue(docs) });
}
function mockContactFind(docs) {
  Contact.find.mockReturnValue({ populate: jest.fn().mockResolvedValue(docs) });
}

describe("findCustomersByPhone", () => {
  afterEach(() => jest.clearAllMocks());

  test("returns not_found for an unparseable caller number, without querying the DB", async () => {
    const result = await findCustomersByPhone("abc", "tenant1");
    expect(result.matchStatus).toBe("not_found");
    expect(result.candidateClientIds).toEqual([]);
    expect(Client.find).not.toHaveBeenCalled();
  });

  test("returns not_found when neither Client nor Contact matches", async () => {
    mockClientFind([]);
    mockContactFind([]);
    const result = await findCustomersByPhone("9876543210", "tenant1");
    expect(result.matchStatus).toBe("not_found");
  });

  test("returns matched for a single Client hit", async () => {
    mockClientFind([{ _id: "client1" }]);
    mockContactFind([]);
    const result = await findCustomersByPhone("9876543210", "tenant1");
    expect(result.matchStatus).toBe("matched");
    expect(result.candidateClientIds).toEqual(["client1"]);
  });

  test("resolves a Contact match up to its parent Client, within the same tenant", async () => {
    mockClientFind([]);
    mockContactFind([{ userid: { _id: "client2", tenant_id: "tenant1" } }]);
    const result = await findCustomersByPhone("9876543210", "tenant1");
    expect(result.matchStatus).toBe("matched");
    expect(result.candidateClientIds).toEqual(["client2"]);
  });

  test("ignores a Contact match whose parent Client belongs to a different tenant", async () => {
    mockClientFind([]);
    mockContactFind([{ userid: { _id: "client3", tenant_id: "other-tenant" } }]);
    const result = await findCustomersByPhone("9876543210", "tenant1");
    expect(result.matchStatus).toBe("not_found");
  });

  test("returns ambiguous when a direct Client and an unrelated Client's Contact both match", async () => {
    mockClientFind([{ _id: "client1" }]);
    mockContactFind([{ userid: { _id: "client4", tenant_id: "tenant1" } }]);
    const result = await findCustomersByPhone("9876543210", "tenant1");
    expect(result.matchStatus).toBe("ambiguous");
    expect(result.candidateClientIds.sort()).toEqual(["client1", "client4"]);
  });

  test("dedupes when a Client and its own Contact both match the same number", async () => {
    mockClientFind([{ _id: "client1" }]);
    mockContactFind([{ userid: { _id: "client1", tenant_id: "tenant1" } }]);
    const result = await findCustomersByPhone("9876543210", "tenant1");
    expect(result.matchStatus).toBe("matched");
    expect(result.candidateClientIds).toEqual(["client1"]);
  });
});
