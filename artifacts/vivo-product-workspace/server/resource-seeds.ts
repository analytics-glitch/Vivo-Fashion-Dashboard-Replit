export type ResourceCategory = "Technical" | "Planning" | "Strategy" | "Buying";

export type ResourceSeed = {
  title: string;
  category: ResourceCategory;
  description: string;
  sourceUrl: string;
  contentMarkdown: string;
};

const referenceContent = (title: string, description: string, sourceUrl: string) => `# ${title}

${description}

## Source document

[Open in Google Drive](${sourceUrl})
`;

const POM_SOURCE_URL = "https://docs.google.com/spreadsheets/d/1G8cciZtwD0jWYBsyP4MN80et34KUpvWQcQVTEOlzaeU/edit?gid=0";

export const RESOURCE_SEEDS: ResourceSeed[] = [
  {
    title: "POM Specifications — Shirts & Blouses",
    category: "Technical",
    description: "Point of measure guide for shirts and blouses — neck, shoulder, bust, waist, hip, sleeve, armhole, pocket and placket measurements.",
    sourceUrl: POM_SOURCE_URL,
    contentMarkdown: referenceContent("POM Specifications — Shirts & Blouses", "Point of measure guide for shirts and blouses — neck, shoulder, bust, waist, hip, sleeve, armhole, pocket and placket measurements.", POM_SOURCE_URL),
  },
  {
    title: "POM Specifications — Dresses",
    category: "Technical",
    description: "Point of measure guide for dresses — HPS to bust point, bust, waist, hip, shoulder width, armhole, sleeve lengths (cap/short/elbow/3⁄4/full), dart placement, CF/CB length, zip length.",
    sourceUrl: POM_SOURCE_URL,
    contentMarkdown: referenceContent("POM Specifications — Dresses", "Point of measure guide for dresses — HPS to bust point, bust, waist, hip, shoulder width, armhole, sleeve lengths (cap/short/elbow/3⁄4/full), dart placement, CF/CB length, zip length.", POM_SOURCE_URL),
  },
  {
    title: "POM Specifications — Trousers & Pants",
    category: "Technical",
    description: "Point of measure guide for trousers — waist (relaxed/stretched), hip, front/back rise, inseam, outseam, thigh, knee, leg opening, fly length, waistband, pocket bag depth, full length.",
    sourceUrl: POM_SOURCE_URL,
    contentMarkdown: referenceContent("POM Specifications — Trousers & Pants", "Point of measure guide for trousers — waist (relaxed/stretched), hip, front/back rise, inseam, outseam, thigh, knee, leg opening, fly length, waistband, pocket bag depth, full length.", POM_SOURCE_URL),
  },
  {
    title: "POM Specifications — Jumpsuits",
    category: "Technical",
    description: "Point of measure guide for jumpsuits — shoulder, HPS to waist, chest/bust, waist, hip, inseam, outseam, sleeve length, rise, thigh, hem opening, zip length, CF/CB length.",
    sourceUrl: POM_SOURCE_URL,
    contentMarkdown: referenceContent("POM Specifications — Jumpsuits", "Point of measure guide for jumpsuits — shoulder, HPS to waist, chest/bust, waist, hip, inseam, outseam, sleeve length, rise, thigh, hem opening, zip length, CF/CB length.", POM_SOURCE_URL),
  },
  {
    title: "POM Specifications — Skirts",
    category: "Technical",
    description: "Point of measure guide for skirts — waist, hip, CF/CB/side length, sweep/hem width, dart length, zipper length, pocket placement, waistband width, slit length.",
    sourceUrl: POM_SOURCE_URL,
    contentMarkdown: referenceContent("POM Specifications — Skirts", "Point of measure guide for skirts — waist, hip, CF/CB/side length, sweep/hem width, dart length, zipper length, pocket placement, waistband width, slit length.", POM_SOURCE_URL),
  },
  {
    title: "POM Specifications — Jackets & Blazers",
    category: "Technical",
    description: "Point of measure guide for jackets and blazers — shoulder, bust, waist, hip, sleeve length/opening/bicep, armhole, HPS to hem, collar height, pocket placement, lining length, shoulder pad width.",
    sourceUrl: POM_SOURCE_URL,
    contentMarkdown: referenceContent("POM Specifications — Jackets & Blazers", "Point of measure guide for jackets and blazers — shoulder, bust, waist, hip, sleeve length/opening/bicep, armhole, HPS to hem, collar height, pocket placement, lining length, shoulder pad width.", POM_SOURCE_URL),
  },
  {
    title: "Monthly Product Planning SOP",
    category: "Planning",
    description: "Controls monthly product plan execution — subcategory MIN/MAX floors, financial spine, order checklist (11 points), post-order pulse (Weeks 2/4/6), reorder discipline, variance control.",
    sourceUrl: "https://docs.google.com/document/d/1Jwr2nPPBBhYU0DdsmZVUPFTkrRy_T6ZXD_qzb0RGRlU/edit",
    contentMarkdown: referenceContent("Monthly Product Planning SOP", "Controls monthly product plan execution — subcategory MIN/MAX floors, financial spine, order checklist (11 points), post-order pulse (Weeks 2/4/6), reorder discipline, variance control.", "https://docs.google.com/document/d/1Jwr2nPPBBhYU0DdsmZVUPFTkrRy_T6ZXD_qzb0RGRlU/edit"),
  },
  {
    title: "Product Team SOP 2026",
    category: "Strategy",
    description: "2026 Operating Model — KES 1.45B target, 3 strategic bets, 4-tier range framework (NOOS/Core/Recent/New), Route 1–4 launch strategy, collections framework, KPI dashboard, store input system, key rules & thresholds.",
    sourceUrl: "https://docs.google.com/presentation/d/1iIHwRMsdO_DUeREGZ56M-PXcr1jDSMr9/edit",
    contentMarkdown: referenceContent("Product Team SOP 2026", "2026 Operating Model — KES 1.45B target, 3 strategic bets, 4-tier range framework (NOOS/Core/Recent/New), Route 1–4 launch strategy, collections framework, KPI dashboard, store input system, key rules & thresholds.", "https://docs.google.com/presentation/d/1iIHwRMsdO_DUeREGZ56M-PXcr1jDSMr9/edit"),
  },
  {
    title: "Buying & Allocations SOP",
    category: "Buying",
    description: "BA-SOP-001 (buying process), BA-SOP-002 (allocation rules), WL-SOP-001 (waiting list) — full 29-store inventory table with SOH, WOC, avg units/week, revenue %, and allocation guidance.",
    sourceUrl: "https://docs.google.com/document/d/12zhxx364T5Iz7CpnqMZAM9-9S0cAhvJ-6bUVxIAMmk0/edit",
    contentMarkdown: referenceContent("Buying & Allocations SOP", "BA-SOP-001 (buying process), BA-SOP-002 (allocation rules), WL-SOP-001 (waiting list) — full 29-store inventory table with SOH, WOC, avg units/week, revenue %, and allocation guidance.", "https://docs.google.com/document/d/12zhxx364T5Iz7CpnqMZAM9-9S0cAhvJ-6bUVxIAMmk0/edit"),
  },
];