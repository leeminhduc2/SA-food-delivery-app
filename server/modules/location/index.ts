/**
 * Location module public API: addresses, geocoding, walking routes and
 * shipping fees. Location knows nothing about restaurants; callers pass the
 * destination's coordinates (see catalog/application/restaurant-location.ts).
 */
export { addressRoutes } from './address.routes.js';
export { defaultAddressFor, type DeliveryAddress } from './application/address.service.js';
export {
  deliveryAddressForActor,
  deliveryInfo,
  locatePlace,
  noAddressInfo,
  unavailableDeliveryInfo,
  type DeliveryInfo,
  type PlaceLocation,
} from './application/shipping.service.js';
export { isValidCoordinate, type LatLng, type ShippingConfig } from './domain/geo.js';
