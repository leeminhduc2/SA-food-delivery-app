import L from 'leaflet';
import { Crosshair, MapPin, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { errorText } from '../types';

export type SavedAddress = {
  id: string;
  address: string;
  formattedAddress: string | null;
  latitude: number;
  longitude: number;
  isDefault: boolean;
  updatedAt: string;
};

type RouteGeometry = { type: 'LineString'; coordinates: [number, number][] };

const tileUrl =
  (import.meta.env.VITE_MAP_TILE_URL as string | undefined) ||
  'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const tileAttribution =
  (import.meta.env.VITE_MAP_TILE_ATTRIBUTION as string | undefined) ||
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function pinIcon(className: string): L.DivIcon {
  return L.divIcon({
    className: 'map-pin ' + className,
    html: '<span></span>',
    iconSize: [22, 30],
    iconAnchor: [11, 29],
  });
}

export function AddressMap({
  center,
  marker,
  onPick,
  route,
  restaurant,
  height = 260,
}: {
  center: [number, number];
  marker: [number, number] | null;
  onPick?: (latitude: number, longitude: number) => void;
  route?: RouteGeometry;
  restaurant?: { latitude: number; longitude: number; name: string } | null;
  height?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const restaurantRef = useRef<L.Marker | null>(null);
  const lineRef = useRef<L.Polyline | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const [centerLat, centerLon] = center;
  const [markerLat, markerLon] = marker || [0, 0];

  useEffect(() => {
    if (!container.current || mapRef.current) return;
    const map = L.map(container.current, { scrollWheelZoom: false }).setView(center, 15);
    L.tileLayer(tileUrl, { attribution: tileAttribution, maxZoom: 19 }).addTo(map);
    map.on('click', (event: L.LeafletMouseEvent) =>
      onPickRef.current?.(event.latlng.lat, event.latlng.lng),
    );
    mapRef.current = map;
    const timer = setTimeout(() => map.invalidateSize(), 80);
    return () => {
      clearTimeout(timer);
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      restaurantRef.current = null;
      lineRef.current = null;
    };
    // The map is created once; later prop changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setView([centerLat, centerLon], map.getZoom() || 15);
  }, [centerLat, centerLon]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!marker) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    if (!markerRef.current) {
      markerRef.current = L.marker(marker, {
        icon: pinIcon('delivery-pin'),
        draggable: Boolean(onPick),
        keyboard: false,
      }).addTo(map);
      markerRef.current.on('dragend', () => {
        const point = markerRef.current?.getLatLng();
        if (point) onPickRef.current?.(point.lat, point.lng);
      });
    } else markerRef.current.setLatLng(marker);
  }, [markerLat, markerLon, Boolean(marker), onPick]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!restaurant) {
      restaurantRef.current?.remove();
      restaurantRef.current = null;
      return;
    }
    const point: [number, number] = [restaurant.latitude, restaurant.longitude];
    if (!restaurantRef.current) {
      restaurantRef.current = L.marker(point, {
        icon: pinIcon('restaurant-pin'),
        keyboard: false,
      })
        .addTo(map)
        .bindTooltip(restaurant.name);
    } else restaurantRef.current.setLatLng(point);
  }, [restaurant]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!route || route.coordinates.length < 2) {
      lineRef.current?.remove();
      lineRef.current = null;
      return;
    }
    const points = route.coordinates.map(
      ([longitude, latitude]) => [latitude, longitude] as [number, number],
    );
    if (!lineRef.current)
      lineRef.current = L.polyline(points, { color: '#19634d', weight: 5 }).addTo(map);
    else lineRef.current.setLatLngs(points);
    const bounds = L.latLngBounds(points);
    if (restaurant) bounds.extend([restaurant.latitude, restaurant.longitude]);
    map.fitBounds(bounds.pad(0.2));
  }, [route, restaurant]);

  return (
    <div className="map-shell" style={{ height }}>
      <div ref={container} className="map-canvas" aria-label="Delivery map" />
      <p className="map-attribution-note">
        Walking routes use the OpenStreetMap pedestrian network via Valhalla. Map data ©
        OpenStreetMap contributors.
      </p>
    </div>
  );
}

export function AddressSettings({
  saved,
  onSaved,
}: {
  saved: SavedAddress | null;
  onSaved: (address: SavedAddress) => void;
}) {
  const [typed, setTyped] = useState(saved?.address || '');
  const [draft, setDraft] = useState<{
    address: string;
    formattedAddress: string;
    latitude: number;
    longitude: number;
  } | null>(
    saved
      ? {
          address: saved.address,
          formattedAddress: saved.formattedAddress || saved.address,
          latitude: saved.latitude,
          longitude: saved.longitude,
        }
      : null,
  );
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!saved) return;
    setTyped(saved.address);
    setDraft({
      address: saved.address,
      formattedAddress: saved.formattedAddress || saved.address,
      latitude: saved.latitude,
      longitude: saved.longitude,
    });
  }, [saved]);

  async function findAddress() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const found = await api('/geocode', 'POST', { address: typed });
      setDraft({
        address: typed,
        formattedAddress: found.formattedAddress,
        latitude: found.latitude,
        longitude: found.longitude,
      });
      setMessage('Address found. Drag the pin or tap the map to fine-tune it.');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function pick(latitude: number, longitude: number) {
    setDraft((current) => ({
      address: current?.address || typed || 'Vị trí đã chọn',
      formattedAddress: 'Đang xác định địa chỉ…',
      latitude,
      longitude,
    }));
    setError('');
    try {
      const resolved = await api('/geocode/reverse', 'POST', { latitude, longitude });
      setDraft((current) =>
        current
          ? {
              ...current,
              address:
                current.address.trim().length >= 5 ? current.address : resolved.formattedAddress,
              formattedAddress: resolved.formattedAddress,
            }
          : current,
      );
      setMessage('Location updated. Save it to use walking delivery pricing.');
    } catch (e) {
      setError(errorText(e));
    }
  }

  function useCurrentLocation() {
    if (!navigator.geolocation) {
      setError(
        'Your browser does not support location access. You can still search for an address.',
      );
      return;
    }
    setLocating(true);
    setError('');
    setMessage('');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        pick(position.coords.latitude, position.coords.longitude);
      },
      () => {
        setLocating(false);
        setError(
          'Location access was declined or unavailable. Search for an address or choose a point on the map instead.',
        );
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  }

  async function save() {
    if (!draft) {
      setError('Find the address or choose a point on the map first.');
      return;
    }
    // A map point chosen without typing an address still has a reverse-geocoded
    // label in draft.address.
    const addressText = typed.trim().length >= 5 ? typed.trim() : draft.address.trim();
    if (addressText.length < 5) {
      setError('Enter a street address, building or neighbourhood.');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const row = await api('/users/me/delivery-address', 'PUT', {
        address: addressText,
        latitude: draft.latitude,
        longitude: draft.longitude,
      });
      onSaved(row);
      setMessage('Delivery address saved. Distances and fees have been refreshed.');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="address-settings" aria-labelledby="delivery-address-title">
      <div className="between">
        <h3 id="delivery-address-title">Delivery address</h3>
        {saved && <span className="delivery-chip">Default address saved</span>}
      </div>
      <p className="muted">
        Search for your address or choose a point on the map. We use it only to calculate walking
        distance and the delivery fee. Location access is optional.
      </p>
      {saved && (
        <p className="current-address">
          <MapPin size={16} />
          <span>
            <strong>{saved.address}</strong>
            {saved.formattedAddress && saved.formattedAddress !== saved.address && (
              <small>{saved.formattedAddress}</small>
            )}
            <small>
              {saved.latitude.toFixed(5)}, {saved.longitude.toFixed(5)}
            </small>
          </span>
        </p>
      )}
      <div className="address-search">
        <label className="field">
          Street address
          <input
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value);
              setDraft(null);
              setMessage('');
            }}
            placeholder="Số nhà, đường, phường, quận, Hà Nội"
            autoComplete="street-address"
          />
        </label>
        <button
          type="button"
          className="button secondary"
          onClick={findAddress}
          disabled={busy || typed.trim().length < 5}
        >
          <Search size={16} />
          Find address
        </button>
        <button
          type="button"
          className="button ghost"
          onClick={useCurrentLocation}
          disabled={locating}
        >
          <Crosshair size={16} />
          {locating ? 'Locating…' : 'Use current location'}
        </button>
      </div>
      {draft && (
        <p className="resolved-address" role="status">
          <MapPin size={15} />
          {draft.formattedAddress}
        </p>
      )}
      <AddressMap
        center={[draft?.latitude ?? 21.0285, draft?.longitude ?? 105.8542]}
        marker={draft ? [draft.latitude, draft.longitude] : null}
        onPick={pick}
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="info" role="status">
          {message}
        </p>
      )}
      <button type="button" className="button full" onClick={save} disabled={busy || !draft}>
        {busy ? 'Saving address…' : 'Save delivery address'}
      </button>
    </section>
  );
}
