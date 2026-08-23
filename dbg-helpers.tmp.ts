const pick = <T>(random: () => number, items: T[]): T | undefined => items[Math.floor(random() * items.length)];
