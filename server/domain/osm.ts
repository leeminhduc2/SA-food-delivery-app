/**
 * Pure OpenStreetMap types and normalization helpers.
 *
 * This module deliberately has no Express or database imports: the import
 * pipeline validates and normalizes external data before any SQL runs.
 */

export const osmAmenities = ['restaurant', 'fast_food', 'food_court'] as const;
export type OsmAmenity = (typeof osmAmenities)[number];
export const osmTypes = ['node', 'way', 'relation'] as const;
export type OsmType = (typeof osmTypes)[number];

/** [south, west, north, east] in WGS84 degrees. */
export type BBox = [number, number, number, number];

export type NormalizedRestaurant = {
  osmType: OsmType;
  osmId: string;
  name: string;
  amenity: OsmAmenity;
  cuisine: string | null;
  latitude: number;
  longitude: number;
  address: string | null;
  addressTags: Record<string, string>;
  phone: string | null;
  website: string | null;
  openingHours: string | null;
  tags: Record<string, string>;
};

export type InvalidOsmRecord = {
  osmType: string | null;
  osmId: string | null;
  name: string | null;
  reason: string;
};

export type MissingFieldCounts = {
  address: number;
  cuisine: number;
  phone: number;
  website: number;
  openingHours: number;
};

export type NormalizeResult = {
  valid: NormalizedRestaurant[];
  invalid: InvalidOsmRecord[];
  duplicates: number;
  missing: MissingFieldCounts;
};

export type ImportFailure = {
  osmType: string;
  osmId: string;
  error: string;
};

export type ImportReport = {
  dryRun: boolean;
  endpoint: string;
  bbox: BBox;
  fetched: number;
  valid: number;
  duplicates: number;
  invalid: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  wouldCreate: number;
  wouldUpdate: number;
  wouldSkip: number;
  newRecords: number;
  existingRecords: number;
  invalidReasons: Record<string, number>;
  missingFields: MissingFieldCounts;
  failures: ImportFailure[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
};

export const DEFAULT_HANOI_BBOX: BBox = [20.95, 105.75, 21.1, 105.9];

/** Parse `south,west,north,east` from an environment variable or CLI flag. */
export function parseBBox(value: unknown): BBox {
  const parts =
    typeof value === 'string'
      ? value.split(',').map((part) => part.trim())
      : Array.isArray(value)
        ? value
        : null;
  if (!parts || parts.length !== 4) throw new Error('Bounding box must be south,west,north,east.');
  const numbers = parts.map(Number);
  if (!numbers.every((number) => Number.isFinite(number)))
    throw new Error('Bounding box coordinates must be finite numbers.');
  const [south, west, north, east] = numbers as BBox;
  if (south < -90 || north > 90 || west < -180 || east > 180)
    throw new Error('Bounding box coordinates are outside WGS84 bounds.');
  if (south >= north || west >= east)
    throw new Error('Bounding box requires south < north and west < east.');
  if (north - south > 1 || east - west > 1)
    throw new Error('Bounding box is larger than the 1 degree import limit.');
  return [south, west, north, east];
}

export function bboxToString(bbox: BBox): string {
  return bbox.join(',');
}

/** Trim, collapse whitespace, remove control characters, cap the length. */
export function normalizeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

function stringTags(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.trim()) tags[key] = value.trim();
  }
  return tags;
}

function coordinate(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function addressFromTags(tags: Record<string, string>): string | null {
  if (tags['addr:full']) return normalizeText(tags['addr:full'], 300);
  const parts = [
    tags['addr:housenumber'],
    tags['addr:street'],
    tags['addr:place'],
    tags['addr:suburb'],
    tags['addr:ward'],
    tags['addr:district'],
    tags['addr:city'],
    tags['addr:province'],
  ]
    .map((part) => normalizeText(part, 120))
    .filter((part): part is string => Boolean(part));
  const unique = parts.filter((part, index) => parts.indexOf(part) === index);
  return unique.length ? normalizeText(unique.join(', '), 300) : null;
}

/**
 * Normalize raw Overpass elements, dropping unnamed/invalid records and
 * deduplicating by the OSM type+id pair. Missing values stay `null`; nothing is
 * inferred or invented.
 */
export function normalizeOsmElements(rawElements: unknown): NormalizeResult {
  const elements = Array.isArray(rawElements) ? rawElements : [];
  const valid: NormalizedRestaurant[] = [];
  const invalid: InvalidOsmRecord[] = [];
  const seen = new Set<string>();
  const missing: MissingFieldCounts = {
    address: 0,
    cuisine: 0,
    phone: 0,
    website: 0,
    openingHours: 0,
  };
  let duplicates = 0;

  for (const raw of elements) {
    const element = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const osmType = typeof element.type === 'string' ? element.type : null;
    const osmId =
      typeof element.id === 'number' || typeof element.id === 'string' ? String(element.id) : null;
    const tags = stringTags(element.tags);
    const name = normalizeText(
      tags.name || tags['name:vi'] || tags['name:en'] || tags['name:zh'],
      200,
    );
    const amenity = typeof tags.amenity === 'string' ? tags.amenity.toLowerCase() : null;
    const base = { osmType, osmId, name };

    if (!osmType || !osmTypes.includes(osmType as OsmType)) {
      invalid.push({ ...base, reason: 'unsupported_type' });
      continue;
    }
    if (!osmId) {
      invalid.push({ ...base, reason: 'missing_osm_id' });
      continue;
    }
    if (!name) {
      invalid.push({ ...base, reason: 'missing_name' });
      continue;
    }
    if (!amenity || !osmAmenities.includes(amenity as OsmAmenity)) {
      invalid.push({ ...base, reason: 'unsupported_amenity' });
      continue;
    }
    const center = (
      element.center && typeof element.center === 'object' ? element.center : {}
    ) as Record<string, unknown>;
    const latitude = coordinate(element.lat) ?? coordinate(center.lat);
    const longitude = coordinate(element.lon) ?? coordinate(center.lon);
    if (
      latitude === null ||
      longitude === null ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      invalid.push({ ...base, reason: 'invalid_coordinates' });
      continue;
    }
    const key = `${osmType}/${osmId}`;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);

    const addressTags: Record<string, string> = {};
    for (const [tag, value] of Object.entries(tags))
      if (tag.startsWith('addr:')) addressTags[tag] = value;

    const record: NormalizedRestaurant = {
      osmType: osmType as OsmType,
      osmId,
      name,
      amenity: amenity as OsmAmenity,
      cuisine: normalizeText(tags.cuisine, 100),
      latitude,
      longitude,
      address: addressFromTags(tags),
      addressTags,
      phone: normalizeText(tags.phone || tags['contact:phone'], 100),
      website: normalizeText(tags.website || tags['contact:website'], 500),
      openingHours: normalizeText(tags.opening_hours, 300),
      tags,
    };
    if (!record.address) missing.address++;
    if (!record.cuisine) missing.cuisine++;
    if (!record.phone) missing.phone++;
    if (!record.website) missing.website++;
    if (!record.openingHours) missing.openingHours++;
    valid.push(record);
  }

  valid.sort((a, b) =>
    a.osmType === b.osmType ? a.osmId.localeCompare(b.osmId) : a.osmType.localeCompare(b.osmType),
  );
  return { valid, invalid, duplicates, missing };
}
