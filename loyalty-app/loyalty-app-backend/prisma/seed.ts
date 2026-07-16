import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding tiers…");
  const tiers = [
    {
      name: "Bronze",
      slug: "bronze",
      minPoints: 0,
      multiplier: 1.0,
      color: "#b8763e",
      icon: "🥉",
      sortOrder: 0,
      perks: ["Earn 1x points on every order", "Members-only offers"],
    },
    {
      name: "Silver",
      slug: "silver",
      minPoints: 2000,
      multiplier: 1.25,
      color: "#9ca3af",
      icon: "🥈",
      sortOrder: 1,
      perks: ["Earn 1.25x points", "Early access to drops", "Free shipping over threshold"],
    },
    {
      name: "Gold",
      slug: "gold",
      minPoints: 6000,
      multiplier: 1.5,
      color: "#eab308",
      icon: "🥇",
      sortOrder: 2,
      perks: ["Earn 1.5x points", "Birthday gift", "Priority support", "Exclusive rewards"],
    },
    {
      name: "Platinum",
      slug: "platinum",
      minPoints: 15000,
      multiplier: 2.0,
      color: "#7c3aed",
      icon: "💎",
      sortOrder: 3,
      perks: ["Earn 2x points", "VIP concierge", "Free express shipping", "First-look launches"],
    },
  ];

  for (const t of tiers) {
    await prisma.tier.upsert({
      where: { slug: t.slug },
      update: { ...t, perks: t.perks },
      create: { ...t, perks: t.perks },
    });
  }

  console.log("🎁 Seeding rewards…");
  const rewards = [
    {
      title: "KSh 200 off",
      description: "Get KSh 200 off your next order.",
      pointsCost: 1000,
      type: "FIXED_DISCOUNT" as const,
      value: 200,
      sortOrder: 0,
    },
    {
      title: "10% off",
      description: "Enjoy 10% off your entire order.",
      pointsCost: 1500,
      type: "PERCENT_DISCOUNT" as const,
      value: 10,
      sortOrder: 1,
    },
    {
      title: "Free shipping",
      description: "Free shipping on your next order.",
      pointsCost: 800,
      type: "FREE_SHIPPING" as const,
      value: 0,
      sortOrder: 2,
    },
    {
      title: "KSh 500 off",
      description: "A bigger treat — KSh 500 off.",
      pointsCost: 2200,
      type: "FIXED_DISCOUNT" as const,
      value: 500,
      sortOrder: 3,
    },
    {
      title: "20% off (VIP)",
      description: "20% off — for our top-tier members.",
      pointsCost: 4000,
      type: "PERCENT_DISCOUNT" as const,
      value: 20,
      sortOrder: 4,
    },
  ];

  for (const r of rewards) {
    const existing = await prisma.reward.findFirst({ where: { title: r.title } });
    if (existing) {
      await prisma.reward.update({ where: { id: existing.id }, data: r });
    } else {
      await prisma.reward.create({ data: r });
    }
  }

  console.log("✅ Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
