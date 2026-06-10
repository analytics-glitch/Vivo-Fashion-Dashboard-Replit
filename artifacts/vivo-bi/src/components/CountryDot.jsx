import { countryColor } from "@/lib/api";

/**
 * CountryDot — renders a country as a colored accent dot + its name.
 * Replaces flag glyphs throughout the app (user preference: no flags/emojis).
 * Pass `dotOnly` to render just the dot (e.g. inside tight table cells).
 */
export default function CountryDot({ country, dotOnly = false, className = "" }) {
  const dot = (
    <span
      className="inline-block w-2 h-2 rounded-full shrink-0"
      style={{ backgroundColor: countryColor(country) }}
      aria-hidden="true"
    />
  );
  if (dotOnly) return dot;
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      {dot}
      <span>{country}</span>
    </span>
  );
}
