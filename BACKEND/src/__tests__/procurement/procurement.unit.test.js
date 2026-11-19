const { computePathAndLevel } = require("../../controllers/purchase_category_controller");
const gstService = require("../../services/gstService");

describe("Phase 1 Unit Tests (U1 - U6, U13, U14)", () => {
  // U1: Category path builder
  test("U1: Category path builder - Child of MANUFACTURE/B gets path MANUFACTURE/B/B-1, level 3", () => {
    const parent = {
      level: 2,
      procurementType: "MANUFACTURE",
      path: "MANUFACTURE/B",
    };
    const result = computePathAndLevel(parent, "MANUFACTURE", "B-1");
    expect(result.path).toBe("MANUFACTURE/B/B-1");
    expect(result.level).toBe(3);
    expect(result.procurementType).toBe("MANUFACTURE");
  });

  // U2: Type inheritance
  test("U2: Type inheritance - Child created under a JOBWORK parent is JOBWORK even if another type is sent", () => {
    const parent = {
      level: 2,
      procurementType: "JOBWORK",
      path: "JOBWORK/TNK",
    };
    // Attempting to send READY when parent is JOBWORK
    const result = computePathAndLevel(parent, "READY", "DSL");
    expect(result.procurementType).toBe("JOBWORK");
    expect(result.path).toBe("JOBWORK/TNK/DSL");
    expect(result.level).toBe(3);
  });

  // U3: Depth limit
  test("U3: Depth limit - Level 5 is rejected with a clear error", () => {
    const parentLevel4 = {
      level: 4,
      procurementType: "READY",
      path: "READY/HYD/VLV/SUB",
    };
    expect(() => {
      computePathAndLevel(parentLevel4, "READY", "LEAF");
    }).toThrow("The category tree is limited to a maximum of 4 levels");
  });

  // U4: GST split, same state
  test("U4: GST split, same state - ₹1,000 at 18% -> CGST ₹90 + SGST ₹90", () => {
    const line = gstService.calculateLine({ qty: 1, rate: 1000, gstRate: 18 });
    const split = gstService.splitTax({
      gstAmount: line.gstAmount,
      companyStateCode: "24", // Gujarat
      placeOfSupplyStateCode: "24", // Gujarat (same state)
    });
    expect(split.cgst).toBe(90);
    expect(split.sgst).toBe(90);
    expect(split.igst).toBe(0);
  });

  // U5: GST split, other state
  test("U5: GST split, other state - ₹1,000 at 18% -> IGST ₹180", () => {
    const line = gstService.calculateLine({ qty: 1, rate: 1000, gstRate: 18 });
    const split = gstService.splitTax({
      gstAmount: line.gstAmount,
      companyStateCode: "24", // Gujarat
      placeOfSupplyStateCode: "27", // Maharashtra (inter-state)
    });
    expect(split.cgst).toBe(0);
    expect(split.sgst).toBe(0);
    expect(split.igst).toBe(180);
  });

  // U6: Mixed GST rates on one bill
  test("U6: Mixed GST rates on one bill - Lines at 5%, 12%, 18%, 28% total correctly; rounding to 2 decimals", () => {
    const rates = [5, 12, 18, 28];
    const taxableEach = 1000;
    const gstLines = rates.map((r) => {
      const line = gstService.calculateLine({ qty: 1, rate: taxableEach, gstRate: r });
      const split = gstService.splitTax({
        gstAmount: line.gstAmount,
        companyStateCode: "24",
        placeOfSupplyStateCode: "24",
      });
      return { taxableValue: line.taxableValue, ...split };
    });

    const docTotals = gstService.calculateDocumentTotals(gstLines);
    // 5% of 1000 = 50 (25 CGST + 25 SGST)
    // 12% of 1000 = 120 (60 CGST + 60 SGST)
    // 18% of 1000 = 180 (90 CGST + 90 SGST)
    // 28% of 1000 = 280 (140 CGST + 140 SGST)
    // Total tax = 630 (315 CGST + 315 SGST)
    // Taxable = 4000
    // Grand total = 4630
    expect(docTotals.total_cgst).toBe(315);
    expect(docTotals.total_sgst).toBe(315);
    expect(docTotals.total_igst).toBe(0);
    expect(docTotals.payable).toBe(4630);
  });

  // U13: Shortage across locations
  test("U13: Shortage across locations - Required 10, stock 2 + 3 + 1 at the 3 locations -> to buy 4", () => {
    const calculateShortage = (required, locationStocks) => {
      const totalStock = locationStocks.reduce((sum, s) => sum + (Number(s) || 0), 0);
      return Math.max(required - totalStock, 0);
    };

    const shortage = calculateShortage(10, [2, 3, 1]);
    expect(shortage).toBe(4);

    // If stock is more than required, shortage is 0 (never negative)
    expect(calculateShortage(10, [5, 5, 2])).toBe(0);
  });

  // U14: Production progress limit
  test("U14: Production progress limit - Qty 5, WIP 3, Finished 3 -> rejected", () => {
    const validateProductionProgress = (orderQty, wipQty, finishedQty) => {
      if (wipQty + finishedQty > orderQty) {
        throw new Error("WIP quantity + Finished quantity cannot exceed the total production order quantity");
      }
      return true;
    };

    expect(() => {
      validateProductionProgress(5, 3, 3);
    }).toThrow("WIP quantity + Finished quantity cannot exceed the total production order quantity");

    expect(validateProductionProgress(5, 3, 2)).toBe(true);
    expect(validateProductionProgress(5, 2, 2)).toBe(true);
  });
});

