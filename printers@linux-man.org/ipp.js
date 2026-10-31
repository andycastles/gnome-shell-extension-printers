// Minimal IPP client for reading printer and job state from the local CUPS
// server, instead of parsing lpstat/lpq output. Only what the extension needs:
// encode a request, POST it to CUPS, decode the response.
//
// IPP encoding: https://www.rfc-editor.org/rfc/rfc8010
// IPP operations and attributes: https://www.rfc-editor.org/rfc/rfc8011
// CUPS operations (CUPS-Get-Printers, CUPS-Get-Default):
// https://openprinting.github.io/cups/doc/spec-ipp.html
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const CUPS_URL = 'http://localhost:631/';

const Operation = {
    GET_JOBS: 0x000a,
    CUPS_GET_DEFAULT: 0x4001,
    CUPS_GET_PRINTERS: 0x4002,
};

const Group = {
    OPERATION: 0x01,
    JOB: 0x02,
    END: 0x03,
    PRINTER: 0x04,
};

const Tag = {
    INTEGER: 0x21,
    BOOLEAN: 0x22,
    ENUM: 0x23,
    DATE_TIME: 0x31,
    BEGIN_COLLECTION: 0x34,
    TEXT_WITH_LANGUAGE: 0x35,
    NAME_WITH_LANGUAGE: 0x36,
    END_COLLECTION: 0x37,
    NAME: 0x42,
    KEYWORD: 0x44,
    URI: 0x45,
    CHARSET: 0x47,
    NATURAL_LANGUAGE: 0x48,
};

const Status = {
    NOT_FOUND: 0x0406,
};

export const PrinterState = {3: 'idle', 4: 'processing', 5: 'stopped'};

export const JobState = {
    3: 'pending', 4: 'pending-held', 5: 'processing', 6: 'processing-stopped',
    7: 'canceled', 8: 'aborted', 9: 'completed',
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class Writer {
    constructor() {
        this._bytes = [];
    }

    u8(value) {
        this._bytes.push(value & 0xff);
    }

    u16(value) {
        this.u8(value >> 8);
        this.u8(value);
    }

    u32(value) {
        this.u16(value >>> 16);
        this.u16(value & 0xffff);
    }

    bytes(array) {
        this.u16(array.length);
        for (const b of array)
            this._bytes.push(b);
    }

    toUint8Array() {
        return new Uint8Array(this._bytes);
    }
}

function encodeValue(tag, value) {
    if (tag === Tag.INTEGER || tag === Tag.ENUM)
        return [value >>> 24 & 0xff, value >>> 16 & 0xff, value >>> 8 & 0xff, value & 0xff];
    if (tag === Tag.BOOLEAN)
        return [value ? 1 : 0];
    return encoder.encode(value);
}

// attributes: [[tag, name, value or array of values], ...], all sent in the
// operation group.
function encodeRequest(operation, requestId, attributes) {
    const w = new Writer();
    w.u8(2); // IPP 2.0
    w.u8(0);
    w.u16(operation);
    w.u32(requestId);
    w.u8(Group.OPERATION);
    for (const [tag, name, value] of attributes) {
        const values = Array.isArray(value) ? value : [value];
        values.forEach((v, i) => {
            w.u8(tag);
            // Additional values of the same attribute have an empty name
            w.bytes(i === 0 ? encoder.encode(name) : []);
            w.bytes(encodeValue(tag, v));
        });
    }
    w.u8(Group.END);
    return w.toUint8Array();
}

function decodeValue(tag, data, view) {
    switch (tag) {
        case Tag.INTEGER:
        case Tag.ENUM:
            return view.getInt32(0);
        case Tag.BOOLEAN:
            return data[0] !== 0;
        case Tag.DATE_TIME:
            return new Date(Date.UTC(view.getUint16(0), data[2] - 1, data[3],
                data[4], data[5], data[6]));
        case Tag.TEXT_WITH_LANGUAGE:
        case Tag.NAME_WITH_LANGUAGE: {
        // language length + language, then text length + text
            const langLength = view.getUint16(0);
            const textLength = view.getUint16(2 + langLength);
            return decoder.decode(data.subarray(4 + langLength, 4 + langLength + textLength));
        }
        default:
        // Out-of-band values (no-value, unknown, unsupported)
            if (tag >= 0x10 && tag <= 0x1f)
                return null;
            return decoder.decode(data);
    }
}

// Returns {statusCode, groups: [{tag, attributes: {name: [values]}}]}.
// Every attribute value is an array, as most can have several values.
function decodeResponse(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const statusCode = view.getUint16(2);
    const groups = [];
    let group = null;
    let name = null;
    let pos = 8;

    const readItem = () => {
        const tag = view.getUint8(pos);
        const nameLength = view.getUint16(pos + 1);
        const itemName = decoder.decode(bytes.subarray(pos + 3, pos + 3 + nameLength));
        pos += 3 + nameLength;
        const valueLength = view.getUint16(pos);
        const data = bytes.subarray(pos + 2, pos + 2 + valueLength);
        pos += 2 + valueLength;
        return {tag, itemName, data};
    };

    while (pos < bytes.length) {
        const tag = view.getUint8(pos);
        if (tag === Group.END)
            break;
        if (tag < 0x10) {
            group = {tag, attributes: {}};
            groups.push(group);
            pos++;
            continue;
        }

        const item = readItem();
        if (item.itemName)
            name = item.itemName;

        let value;
        if (item.tag === Tag.BEGIN_COLLECTION) {
            // Collections aren't needed: skip to the matching end
            let depth = 1;
            while (depth > 0) {
                const member = readItem();
                if (member.tag === Tag.BEGIN_COLLECTION)
                    depth++;
                else if (member.tag === Tag.END_COLLECTION)
                    depth--;
            }
            value = null;
        } else {
            const dataView = new DataView(item.data.buffer, item.data.byteOffset, item.data.byteLength);
            value = decodeValue(item.tag, item.data, dataView);
        }

        (group.attributes[name] ??= []).push(value);
    }
    return {statusCode, groups};
}

export class CupsClient {
    constructor() {
        this._session = new Soup.Session();
        this._requestId = 1;
    }

    destroy() {
        this._session.abort();
        this._session = null;
    }

    async _request(operation, attributes) {
        const body = encodeRequest(operation, this._requestId++, [
            [Tag.CHARSET, 'attributes-charset', 'utf-8'],
            [Tag.NATURAL_LANGUAGE, 'attributes-natural-language', 'en'],
            ...attributes,
        ]);
        const message = Soup.Message.new('POST', CUPS_URL);
        message.set_request_body_from_bytes('application/ipp', new GLib.Bytes(body));
        const response = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
        if (message.get_status() !== Soup.Status.OK)
            throw new Error(`CUPS returned HTTP ${message.get_status()}`);
        return decodeResponse(response.toArray());
    }

    _check(response) {
        if (response.statusCode >= 0x0100)
            throw new Error(`CUPS returned IPP status 0x${response.statusCode.toString(16).padStart(4, '0')}`);
        return response;
    }

    // Like _check, but not-found is an empty result: CUPS answers with it
    // when there are no queues (e.g. once a temporary queue is removed)
    _checkFound(response) {
        if (response.statusCode === Status.NOT_FOUND)
            return {...response, groups: []};
        return this._check(response);
    }

    // All local queues, as printer attribute objects
    async getPrinters() {
        const response = this._checkFound(await this._request(Operation.CUPS_GET_PRINTERS, [
            [Tag.KEYWORD, 'requested-attributes', [
                'printer-name', 'printer-state', 'printer-state-reasons',
                'printer-state-message', 'printer-is-accepting-jobs', 'device-uri',
            ]],
        ]));
        return response.groups.filter(g => g.tag === Group.PRINTER).map(g => g.attributes);
    }

    // Name of the default printer, or null if there is none
    async getDefaultPrinter() {
        const response = await this._request(Operation.CUPS_GET_DEFAULT, [
            [Tag.KEYWORD, 'requested-attributes', 'printer-name'],
        ]);
        if (response.statusCode === Status.NOT_FOUND)
            return null;
        this._check(response);
        const printer = response.groups.find(g => g.tag === Group.PRINTER);
        return printer?.attributes['printer-name']?.[0] ?? null;
    }

    // Not-completed jobs on all printers, as job attribute objects
    async getJobs() {
        const response = this._checkFound(await this._request(Operation.GET_JOBS, [
            [Tag.URI, 'printer-uri', 'ipp://localhost/'],
            [Tag.NAME, 'requesting-user-name', GLib.get_user_name()],
            [Tag.KEYWORD, 'which-jobs', 'not-completed'],
            [Tag.KEYWORD, 'requested-attributes', [
                'job-id', 'job-name', 'job-state', 'job-state-reasons',
                'job-priority', 'job-originating-user-name', 'job-printer-uri',
                'time-at-creation',
            ]],
        ]));
        return response.groups.filter(g => g.tag === Group.JOB).map(g => g.attributes);
    }
}
