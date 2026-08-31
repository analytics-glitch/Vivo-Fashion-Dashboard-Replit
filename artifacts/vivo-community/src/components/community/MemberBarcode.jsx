import React, { useMemo } from "react";

// Code 128 symbol patterns, including the three start symbols and stop
// symbol. Keeping this small encoder local avoids a client-side dependency for
// a value that is rendered on the signed-in Account surface only.
const CODE128_BARS = [
  "11011001100", "11001101100", "11001100110", "10010011000", "10010001100",
  "10001001100", "10011001000", "10011000100", "10001100100", "11001001000",
  "11001000100", "11000100100", "10110011100", "10011011100", "10011001110",
  "10111001100", "10011101100", "10011100110", "11001110010", "11001011100",
  "11001001110", "11011100100", "11001110100", "11101101110", "11101001100",
  "11100101100", "11100100110", "11101100100", "11100110100", "11100110010",
  "11011011000", "11011000110", "11000110110", "10100011000", "10001011000",
  "10001000110", "10110001000", "10001101000", "10001100010", "11010001000",
  "11000101000", "11000100010", "10110111000", "10110001110", "10001101110",
  "10111011000", "10111000110", "10001110110", "11101110110", "11010001110",
  "11000101110", "11011101000", "11011100010", "11011101110", "11101011000",
  "11101000110", "11100010110", "11101101000", "11101100010", "11100011010",
  "11101111010", "11001000010", "11110001010", "10100110000", "10100001100",
  "10010110000", "10010000110", "10000101100", "10000100110", "10110010000",
  "10110000100", "10011010000", "10011000010", "10000110100", "10000110010",
  "11000010010", "11001010000", "11110111010", "11000010100", "10001111010",
  "10100111100", "10010111100", "10010011110", "10111100100", "10011110100",
  "10011110010", "11110100100", "11110010100", "11110010010", "11011011110",
  "11011110110", "11110110110", "10101111000", "10100011110", "10001011110",
  "10111101000", "10111100010", "11110101000", "11110100010", "10111011110",
  "10111101110", "11101011110", "11110101110", "11010000100", "11010010000",
  "11010011100", "1100011101011",
];

function encodeCode128B(value) {
  const data = Array.from(String(value || "")).filter((char) => {
    const code = char.charCodeAt(0);
    return code >= 32 && code <= 127;
  });
  const values = data.map((char) => char.charCodeAt(0) - 32);
  const checksum = values.reduce((sum, code, index) => sum + code * (index + 1), 104) % 103;
  return [104, ...values, checksum, 106]
    .map((symbol) => CODE128_BARS[symbol])
    .join("");
}

export default function MemberBarcode({ value }) {
  const code = String(value || "").trim();
  const bars = useMemo(() => (code ? encodeCode128B(code) : ""), [code]);
  if (!code || !bars) return null;

  const moduleWidth = 2;
  const quietZone = 12;
  const viewWidth = bars.length * moduleWidth + quietZone * 2;
  const barHeight = 48;
  const rects = [];
  let runStart = -1;
  for (let index = 0; index <= bars.length; index += 1) {
    const isBar = bars[index] === "1";
    if (isBar && runStart < 0) runStart = index;
    if ((!isBar || index === bars.length) && runStart >= 0) {
      rects.push(
        <rect
          key={`${runStart}-${index}`}
          x={quietZone + runStart * moduleWidth}
          y="0"
          width={(index - runStart) * moduleWidth}
          height={barHeight}
          fill="currentColor"
        />,
      );
      runStart = -1;
    }
  }

  return (
    <div
      className="relative z-10 mt-6 rounded-sm bg-background px-4 py-4 text-foreground"
      data-testid="member-barcode"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
          Member barcode
        </span>
        <span className="text-[10px] text-muted-foreground">Show at checkout</span>
      </div>
      <svg
        role="img"
        aria-label={`Member barcode ${code}`}
        viewBox={`0 0 ${viewWidth} ${barHeight}`}
        className="block h-14 w-full"
        preserveAspectRatio="none"
      >
        {rects}
      </svg>
      <div className="mt-1 text-center font-mono text-[11px] tracking-[0.18em] text-muted-foreground">
        {code}
      </div>
    </div>
  );
}