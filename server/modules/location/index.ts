/**
 * Location module public API: addresses, geocoding, walking routes and
 * shipping fees. Location knows nothing about restaurants; callers pass the
 * destination's coordinates (see catalog/application/restaurant-location.ts).
 */
export { addressRoutes } from './address.routes.js';
export {
  latestDriverLocation,
  locationFresh,
  listCandidateLocations,
} from './application/driver-location.service.js';
export {
  recordDriverLocation,
  purgeStaleDriverLocations,
} from './application/driver-location-ingestion.service.js';
export { configureDriverLocation } from './driver-location.ports.js';
export {
  setAddressSavedListener,
  type SavedDeliveryAddress,
} from './application/address-events.js';
export { defaultAddressFor, type DeliveryAddress } from './application/address.service.js';
export {
  cachedDeliveryInfo,
  forgetAddressQuotes,
  forgetRestaurantQuotes,
  quotePricingKey,
  rememberDeliveryInfo,
} from './application/quote-cache.service.js';
export {
  deliveryAddressForActor,
  deliveryInfo,
  locatePlace,
  noAddressInfo,
  shippingConfig,
  unavailableDeliveryInfo,
  type DeliveryInfo,
  type PlaceLocation,
} from './application/shipping.service.js';
export { isValidCoordinate, type LatLng, type ShippingConfig } from './domain/geo.js';
