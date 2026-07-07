// WS8 T806 — single display-name lookup for store/sensor spellings.
//
// The backend canonicalises footfall sensor names via FOOTFALL_LOCATION_ALIASES
// (api_pg.py), so /api responses normally arrive spaced ("Vivo Moi Avenue").
// This frontend lookup is the safety net for spellings the server map hasn't
// caught up with yet (footfallcam silently renames feeds — see 2026-06-07),
// so charts and tables never render "Vivo MoiAV" / "Vivo_MSA_DigoRD" beside
// their spaced twins. Keep this map in sync with FOOTFALL_LOCATION_ALIASES.
const STORE_DISPLAY_ALIASES = {
  "Vivo MoiAV": "Vivo Moi Avenue",
  "Vivo MoiAvenue": "Vivo Moi Avenue",
  "Sarit Centre": "Vivo Sarit",
  "VFGJUNCTION": "Vivo Junction",
  "Yaya Centre": "Vivo Yaya",
  "VIVO Mama Ngina": "Vivo Mama Ngina St",
  "VivoKisumu": "Vivo Kisumu",
  "VIVO Gardencity": "Vivo Garden City",
  "Two Rivers": "Vivo Two Rivers",
  "VIVO Capital": "Vivo Capital Centre",
  "VFGGALLERIAMALL": "Vivo Galleria",
  "VFGELDORET": "Vivo Eldoret",
  "VFGTHEHUB": "Vivo Hub",
  "VIVO Mombasa": "Vivo MSA Digo Road",
  "Vivo_MSA_DigoRD": "Vivo MSA Digo Road",
  "MSA DigoRoad": "Vivo MSA Digo Road",
  "Vivo MSA DigoRoad": "Vivo MSA Digo Road",
  "Acacia Mall": "Vivo Acacia",
  "VivoVillageMKT": "Vivo Village Market",
  "Vivo Runda Mall": "Vivo Runda",
  "Vivo Kigali ": "Vivo Kigali Heights",
  "VIVO MERU": "Vivo Meru",
  "VFGSIGNATURE": "Vivo Signature Mall",
  "KILELESHWA": "Vivo Kileleshwa",
  "VFG T-MALL": "Vivo T- Mall",
  " Oasis mall": "The Oasis Mall",
};

export function displayStoreName(name) {
  if (!name) return name;
  return STORE_DISPLAY_ALIASES[name] || STORE_DISPLAY_ALIASES[String(name).trim()] || name;
}
