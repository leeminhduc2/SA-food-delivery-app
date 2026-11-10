/** Location module public API: addresses, geocoding, walking routes and shipping fees. */
export { addressRoutes } from './address.routes.js';
export { defaultAddressFor, type DeliveryAddress } from './application/address.service.js';
export {
  checkoutDeliveryQuote,
  deliveryAddressForActor,
  deliveryInfoForRestaurant,
  deliveryInfoForRestaurantId,
  noAddressInfo,
  type DeliveryInfo,
} from './application/shipping.service.js';
