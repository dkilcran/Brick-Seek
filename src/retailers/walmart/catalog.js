// Synthetic product catalog used in demo mode. Item ids, UPCs and prices are
// made up; they exist so the full UI can be exercised without API keys.

const RAW = [
  // [itemId, name, brand, category, msrp, onlinePrice, marketplaceSeller?]
  ['501001', '55" Class 4K UHD Smart LED TV', 'Onn', 'Electronics', 348.0, 268.0],
  ['501002', '65" Class QLED 4K Smart TV', 'Vizio', 'Electronics', 599.99, 478.0],
  ['501003', 'Wireless Noise Cancelling Headphones', 'Sony', 'Electronics', 349.99, 248.0],
  ['501004', 'True Wireless Earbuds with Charging Case', 'JLab', 'Electronics', 49.99, 24.88],
  ['501005', '10.1" Android Tablet, 64GB', 'Onn', 'Electronics', 149.0, 98.0],
  ['501006', 'Portable Bluetooth Speaker, Waterproof', 'JBL', 'Electronics', 129.95, 79.0],
  ['501007', 'Smart Watch Fitness Tracker', 'Garmin', 'Electronics', 249.99, 199.0],
  ['502001', 'Video Game Console Bundle', 'Nintendo', 'Video Games', 299.99, 299.0],
  ['502002', 'Wireless Controller - Midnight Black', 'Sony', 'Video Games', 74.99, 54.0],
  ['502003', 'Open-World Adventure Game (Standard Edition)', 'Nintendo', 'Video Games', 69.99, 49.0],
  ['502004', 'Gaming Headset with Mic', 'Turtle Beach', 'Video Games', 59.99, 29.98],
  ['503001', 'Building Bricks Space Shuttle Set, 1,200 pcs', 'LEGO', 'Toys', 119.99, 95.99],
  ['503002', 'Building Bricks Classic Creative Box', 'LEGO', 'Toys', 59.99, 44.97],
  ['503003', 'Fashion Doll Dreamhouse Playset', 'Barbie', 'Toys', 199.99, 159.0],
  ['503004', 'Remote Control Monster Truck', 'Hot Wheels', 'Toys', 69.97, 39.97],
  ['503005', '12V Ride-On Electric Car for Kids', 'Huffy', 'Toys', 249.0, 168.0],
  ['503006', 'Collectible Trading Card Booster Box', 'Pokemon', 'Toys', 143.64, 129.99],
  ['504001', '6-Quart Electric Pressure Cooker', 'Instant Pot', 'Home', 99.95, 59.0],
  ['504002', '5.8-Quart Air Fryer', 'Ninja', 'Home', 129.99, 89.0],
  ['504003', 'Cordless Stick Vacuum', 'Shark', 'Home', 299.99, 179.0],
  ['504004', 'Robot Vacuum with Self-Empty Base', 'iRobot', 'Home', 549.99, 349.0],
  ['504005', '12-Cup Programmable Coffee Maker', 'Mainstays', 'Home', 29.97, 19.88],
  ['504006', 'Queen Memory Foam Mattress, 10"', 'Zinus', 'Home', 299.0, 199.0],
  ['504007', 'Countertop Blender, 72 oz', 'Ninja', 'Home', 119.99, 79.0],
  ['505001', '20V Cordless Drill/Driver Kit', 'DeWalt', 'Tools', 179.0, 99.0],
  ['505002', '200-Piece Mechanics Tool Set', 'Hyper Tough', 'Tools', 49.97, 29.97],
  ['505003', 'Electric Pressure Washer, 2000 PSI', 'Sun Joe', 'Tools', 199.0, 139.0],
  ['506001', '18" Charcoal Kettle Grill', 'Expert Grill', 'Patio & Garden', 89.0, 49.0],
  ['506002', '4-Piece Patio Conversation Set', 'Mainstays', 'Patio & Garden', 399.0, 247.0],
  ['506003', '21" Gas Push Lawn Mower', 'Yard Machines', 'Patio & Garden', 279.0, 198.0],
  ['507001', '26" Mountain Bike, 21-Speed', 'Hyper', 'Sports & Outdoors', 248.0, 148.0],
  ['507002', '6-Person Instant Cabin Tent', 'Ozark Trail', 'Sports & Outdoors', 149.0, 98.0],
  ['507003', '54" Adjustable Basketball Hoop', 'Lifetime', 'Sports & Outdoors', 399.0, 299.0],
  ['508001', 'Baby Convertible Car Seat', 'Graco', 'Baby', 229.99, 179.0],
  ['508002', 'Diapers Size 3, 168 Count', 'Pampers', 'Baby', 52.97, 47.97],
  ['508003', 'Lightweight Travel Stroller', 'Evenflo', 'Baby', 129.99, 89.0],
  ['509001', 'Electric Toothbrush with 2 Brush Heads', 'Oral-B', 'Health & Beauty', 99.99, 59.97],
  ['509002', 'Hair Dryer Brush Volumizer', 'Revlon', 'Health & Beauty', 59.99, 39.88],
  ['510001', 'Laptop 15.6" FHD, 8GB RAM, 256GB SSD', 'HP', 'Computers', 549.0, 379.0],
  ['510002', '27" IPS Monitor, 75Hz', 'Acer', 'Computers', 199.99, 129.0],
  ['510003', 'Wireless Keyboard and Mouse Combo', 'Logitech', 'Computers', 39.99, 24.99],
  ['510004', 'All-in-One Inkjet Printer', 'HP', 'Computers', 129.99, 79.0],
  // Marketplace listings: sold by third parties, so never shown as deals.
  ['511001', 'Shag Area Rug 8x10, Gray', 'Rugshop', 'Home', 399.99, 79.99, 'RugDirect Outlet'],
  ['511002', 'Vintage Medallion Area Rug 5x7', 'Unique Loom', 'Home', 289.0, 54.5, 'HomeDecor Plus LLC'],
  ['511003', 'Bluetooth Earbuds, 3-Pack', 'Generic', 'Electronics', 99.99, 12.99, 'TechDeals Store'],
];

function upcFor(itemId) {
  const body = `0${itemId}${itemId.slice(0, 5)}`.slice(0, 11);
  // UPC-A check digit
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += Number(body[i]) * (i % 2 === 0 ? 3 : 1);
  return body + ((10 - (sum % 10)) % 10);
}

export const CATALOG = RAW.map(([itemId, name, brand, category, msrp, price, seller]) => ({
  itemId,
  name: `${brand} ${name}`,
  brand,
  category,
  msrp,
  price,
  upc: upcFor(itemId),
  seller: seller ?? 'Walmart.com',
}));

export const CATEGORIES = [...new Set(CATALOG.map((p) => p.category))].sort();
