import {
  deliveryInfo,
  isValidCoordinate,
  locatePlace,
  noAddressInfo,
  unavailableDeliveryInfo,
  type DeliveryAddress,
  type DeliveryInfo,
  type PlaceLocation,
  type ShippingConfig,
} from '../../location/index.js';
import * as restaurants from '../infrastructure/restaurant.repository.js';
import type { RestaurantRow } from '../infrastructure/restaurant.repository.js';

type Options = { includeGeometry?: boolean; config?: ShippingConfig };

/** A restaurant's coordinates; a fresh geocode is stored on the restaurant row. */
async function restaurantCoordinates(restaurant: RestaurantRow): Promise<PlaceLocation> {
  const location = await locatePlace(restaurant);
  const geocoded =
    !isValidCoordinate(restaurant.latitude, restaurant.longitude) &&
    location !== null &&
    location !== 'GEOCODING_FAILED';
  if (geocoded && restaurant.address)
    await restaurants.setCoordinates(
      restaurant.id,
      restaurant.address,
      location.latitude,
      location.longitude,
    );
  return location;
}

export async function deliveryInfoForRestaurant(
  restaurant: RestaurantRow,
  address: DeliveryAddress | null,
  options: Options = {},
): Promise<DeliveryInfo> {
  if (!address) return noAddressInfo();
  return deliveryInfo(await restaurantCoordinates(restaurant), address, options);
}

export async function deliveryInfoForRestaurantId(
  restaurantId: string,
  address: DeliveryAddress | null,
  options: Options = {},
): Promise<DeliveryInfo> {
  const restaurant = await restaurants.findById(restaurantId);
  if (!restaurant) return unavailableDeliveryInfo('RESTAURANT_NOT_FOUND');
  return deliveryInfoForRestaurant(restaurant, address, options);
}

/** Used by checkout, which must never trust a client-supplied fee. */
export async function checkoutDeliveryQuote(
  restaurantId: string,
  address: DeliveryAddress,
): Promise<{ info: DeliveryInfo; restaurant: RestaurantRow }> {
  const restaurant = await restaurants.findById(restaurantId);
  if (!restaurant) throw new Error('Restaurant disappeared during checkout.');
  const info = await deliveryInfoForRestaurant(restaurant, address, { includeGeometry: true });
  return { info, restaurant };
}
