import AbstractInt from '@polkadot/types/codec/AbstractInt';

// A sanitizer for arbitrary data that's going to be
// stringified to JSON. We find all instances of `AbstractInt`,
// which is using bn.js as backend, and forcibly serialize it
// to a decimal string.
export function sanitizeNumbers(data: any): any {
    if (data instanceof AbstractInt) {
        return data.toString(10);
    }

    if (data instanceof Object) {
        if (data.raw instanceof AbstractInt) {
            return data.raw.toString(10);
        }

        if (typeof data.toJSON === "function") {
            const json = data.toJSON();

            if (Array.isArray(json)) {
                return data.map(sanitizeNumbers);
            }

            if (json instanceof Object) {
                const obj = {};

                for (const key of Object.keys(json)) {
                    obj[key] = sanitizeNumbers(data[key]);
                }

                return obj;
            }

            return json;
        }

        if (Array.isArray(data)) {
            return data.map(sanitizeNumbers);
        }

        const obj = {};
        for (const key of Object.keys(data)) {
            obj[key] = sanitizeNumbers(data[key]);
        }
        return obj;
    }

    return data;
}