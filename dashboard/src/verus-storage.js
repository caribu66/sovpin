const prim = require('verus-typescript-primitives');
const { CrossChainDataRef, DataDescriptor, URLRef, VdxfUniValue } = prim;
const { CrossChainDataRefKey, DataDescriptorKey } = require('verus-typescript-primitives/dist/vdxf/vdxfdatakeys');

const CROSS_CHAIN_DATA_REF_TYPE_NAMES = {
  [CrossChainDataRef.TYPE_CROSSCHAIN_DATAREF]: 'PBaaSEvidenceRef',
  [CrossChainDataRef.TYPE_IDENTITY_DATAREF]: 'IdentityMultimapRef',
  [CrossChainDataRef.TYPE_URL_REF]: 'URLRef',
};

/**
 * Build the serialized CMM value used by VREAL for a URLRef media entry:
 * DataDescriptor(CrossChainDataRef(URLRef)).
 *
 * `sha256Hex` must be the digest of the referenced bytes, not a hash of the CID.
 * `DataDescriptor` constructor automatically computes `flags` (`FLAG_LABEL_PRESENT = 0x20`,
 * `FLAG_MIME_TYPE_PRESENT = 0x40`, etc.) via `setFlags()`.
 */
function buildUrlRefCmmValue({ url, sha256Hex, label, mimeType }) {
  if (typeof url !== 'string' || url.length === 0) {
    throw new TypeError('A non-empty URL is required for a Verus URLRef');
  }

  const hasHash = sha256Hex !== undefined && sha256Hex !== null && sha256Hex !== '';
  if (hasHash && !/^[0-9a-f]{64}$/i.test(sha256Hex)) {
    throw new TypeError('sha256Hex must be a 32-byte hexadecimal digest');
  }

  const urlRef = new URLRef({
    version: URLRef.HASHDATA_VERSION,
    ...(hasHash ? { flags: URLRef.FLAG_HAS_HASH } : {}),
    url,
    ...(hasHash ? { dataHash: Buffer.from(sha256Hex, 'hex') } : {}),
  });
  const crossChainDataRef = new CrossChainDataRef(urlRef);
  const crossChainUniValue = new VdxfUniValue({ values: [{ [CrossChainDataRefKey.vdxfid]: crossChainDataRef }] });

  const descriptor = new DataDescriptor({
    version: DataDescriptor.DEFAULT_VERSION,
    ...(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}),
    ...(typeof mimeType === 'string' && mimeType.trim() ? { mimeType: mimeType.trim() } : {}),
    objectdata: crossChainUniValue.toBuffer(),
  });

  // Wrap in VDXF universal value so the serialized bytes carry the VDXF
  // type-key wrapper (08a2...) VREAL expects, rather than bare DataDescriptor bytes.
  const uniValue = new VdxfUniValue({ values: [{ [DataDescriptorKey.vdxfid]: descriptor }] });

  return {
    serializedhex: uniValue.toBuffer().toString('hex'),
    urlRef: urlRef.toJson(),
    dataDescriptor: descriptor.toJson(),
  };
}

/**
 * Decode a serializedhex DataDescriptor CMM value, returning both the outer
 * DataDescriptor envelope (`version`, `flags`, `label`, `mimeType`, `hasEncryptedData`,
 * `salt`, `epk`, `ivk`, `ssk`) and the inner `CrossChainDataRef` / `URLRef` when present.
 * Also attempts to parse `objectdata` as JSON (for VREAL's format where objectdata
 * contains hex-encoded JSON with an `uri` field pointing to an IPFS URL).
 */
function decodeDataDescriptorCmmValue(serializedHex) {
  if (typeof serializedHex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(serializedHex)) {
    return null;
  }

  try {
    const rawBuffer = Buffer.from(serializedHex, 'hex');
    // The serialized form is a VdxfUniValue wrapping a DataDescriptor (Verus primitive standard).
    // Unwrap it; fall back to a bare DataDescriptor for legacy serialized bytes.
    let descriptor = null;
    let bytesRead = 0;
    try {
      const uni = new VdxfUniValue();
      const uniBytes = uni.fromBuffer(rawBuffer);
      if (uniBytes === rawBuffer.length && Array.isArray(uni.values) && uni.values.length > 0) {
        const entry = uni.values[0];
        const dd = entry && entry[DataDescriptorKey.vdxfid];
        if (dd instanceof DataDescriptor && dd.isValid()) {
          descriptor = dd;
          bytesRead = rawBuffer.length;
        }
      }
    } catch {
      descriptor = null;
    }
    if (!descriptor) {
      return null;
    }

    let urlRef = null;
    let crossChainDataRef = null;
    let innerType = 'RAW_OBJECTDATA';

    if (descriptor.objectdata?.length) {
      // Unwrap the VdxfUniValue that now wraps the CrossChainDataRef (Verus primitive standard).
      let objectDataBuffer = descriptor.objectdata;
      try {
        const innerUni = new VdxfUniValue();
        if (innerUni.fromBuffer(objectDataBuffer) === objectDataBuffer.length && Array.isArray(innerUni.values) && innerUni.values.length > 0) {
          const innerEntry = innerUni.values[0];
          const innerKey = Object.keys(innerEntry)[0];
          // The wrapped value is a CrossChainDataRef stored as a VDXF object; re-serialize via its buffer if available
          if (innerEntry[innerKey] && typeof innerEntry[innerKey].toBuffer === 'function') {
            objectDataBuffer = innerEntry[innerKey].toBuffer();
          }
        }
      } catch {
        // fall through: try raw objectdata as before
      }
      // Try CrossChainDataRef (URLRef, IdentityMultimapRef, PBaaSEvidenceRef)
      try {
        const reference = new CrossChainDataRef();
        const refBytesRead = reference.fromBuffer(objectDataBuffer);
        if (refBytesRead === objectDataBuffer.length && reference.isValid()) {
          const typeCode = reference.which();
          innerType = CROSS_CHAIN_DATA_REF_TYPE_NAMES[typeCode] || `CrossChainDataRef(${typeCode})`;
          crossChainDataRef = reference.toJson();
          if (typeCode === CrossChainDataRef.TYPE_URL_REF && reference.ref instanceof URLRef) {
            urlRef = reference.ref.toJson();
          }
        }
      } catch {
        urlRef = null;
        crossChainDataRef = null;
      }

    }

    return {
      version: descriptor.version.toNumber(),
      flags: descriptor.flags.toNumber(),
      hasEncryptedData: descriptor.hasEncryptedData(),
      hasLabel: descriptor.hasLabel(),
      hasMimeType: descriptor.hasMIME(),
      label: descriptor.hasLabel() ? descriptor.label : null,
      mimeType: descriptor.hasMIME() ? descriptor.mimeType : null,
      salt: descriptor.hasSalt() && descriptor.salt ? descriptor.salt.toString('hex') : null,
      epk: descriptor.hasEPK() && descriptor.epk ? descriptor.epk.toString('hex') : null,
      ivk: descriptor.hasIVK() && descriptor.ivk ? descriptor.ivk.toString('hex') : null,
      ssk: descriptor.hasSSK() && descriptor.ssk ? descriptor.ssk.toString('hex') : null,
      objectdataHex: descriptor.objectdata ? Buffer.from(descriptor.objectdata).toString('hex') : '',
      innerType,
      crossChainDataRef,
      urlRef,
    };
  } catch {
    return null;
  }
}

/** Decode a serializedhex URLRef CMM value, returning null for other values. */
function decodeUrlRefCmmValue(serializedHex) {
  const decoded = decodeDataDescriptorCmmValue(serializedHex);
  return decoded?.urlRef || null;
}

/**
 * Extract all valid DataDescriptor entries from an identity's contentmultimap,
 * whether they wrap a URLRef, an IdentityMultimapRef, a PBaaSEvidenceRef, or raw/encrypted bytes.
 */
/**
 * Decode a DataDescriptor from its JSON representation (as returned by the Verus daemon).
 * VREAL stores DataDescriptors as JSON objects with an "objectdata" field containing
 * hex-encoded JSON (not as serialized hex strings).
 */
function decodeDataDescriptorFromJson(ddJson) {
  try {
    const objData = ddJson.objectdata || ddJson.objectData || '';
    const objectBuffer = typeof objData === 'string' && objData.length > 0
      ? Buffer.from(objData, 'hex')
      : Buffer.from([]);

    let descriptor;
    try {
      descriptor = DataDescriptor.fromJson(ddJson);
    } catch {
      descriptor = new DataDescriptor({
        version: ddJson.version || 1,
        flags: ddJson.flags || 0,
        mimeType: ddJson.mimetype || ddJson.mimeType || ddJson.mimeType,
        label: ddJson.label,
        objectdata: objectBuffer,
      });
    }

    // Ensure objectdata is set
    if (objectBuffer.length > 0 && (!descriptor.objectdata || descriptor.objectdata.length === 0)) {
      descriptor.objectdata = objectBuffer;
    }

    let urlRef = null;
    let crossChainDataRef = null;
    let innerType = 'RAW_OBJECTDATA';

    if (descriptor.objectdata?.length) {
      // Try CrossChainDataRef
      try {
        const reference = new CrossChainDataRef();
        const refBytesRead = reference.fromBuffer(descriptor.objectdata);
        if (refBytesRead === descriptor.objectdata.length && reference.isValid()) {
          const typeCode = reference.which();
          innerType = CROSS_CHAIN_DATA_REF_TYPE_NAMES[typeCode] || `CrossChainDataRef(${typeCode})`;
          crossChainDataRef = reference.toJson();
          if (typeCode === CrossChainDataRef.TYPE_URL_REF && reference.ref instanceof URLRef) {
            urlRef = reference.ref.toJson();
          }
        }
      } catch {
        urlRef = null;
        crossChainDataRef = null;
      }

    }

    return {
      version: descriptor.version?.toNumber?.() || ddJson.version || 1,
      flags: descriptor.flags?.toNumber?.() || ddJson.flags || 0,
      hasEncryptedData: descriptor.hasEncryptedData?.() || false,
      hasLabel: descriptor.hasLabel?.() || false,
      hasMimeType: descriptor.hasMIME?.() || false,
      label: descriptor.hasLabel?.() ? descriptor.label : (ddJson.label || null),
      mimeType: descriptor.hasMIME?.() ? descriptor.mimeType : (ddJson.mimetype || ddJson.mimeType || null),
      salt: null,
      epk: null,
      ivk: null,
      ssk: null,
      objectdataHex: descriptor.objectdata ? Buffer.from(descriptor.objectdata).toString('hex') : '',
      innerType,
      crossChainDataRef,
      urlRef,
    };
  } catch {
    return null;
  }
}

function extractDataDescriptorsFromCmm(contentmultimap = {}) {
  const descriptors = [];
  const visited = new Set();

  function visit(vdxfKey, value) {
    if (typeof value === 'string') {
      const decoded = decodeDataDescriptorCmmValue(value);
      if (!decoded) return;
      const signature = `${vdxfKey}:${value}`;
      if (visited.has(signature)) return;
      visited.add(signature);
      descriptors.push({
        vdxfKey,
        ...decoded,
      });
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(vdxfKey, item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (typeof value.serializedhex === 'string') {
      visit(vdxfKey, value.serializedhex);
    }

    // Handle DataDescriptor JSON object (VREAL's format from daemon)
    if (
      value && typeof value === 'object' && !Array.isArray(value) &&
      ('version' in value || 'flags' in value) &&
      ('objectdata' in value || 'objectData' in value)
    ) {
      const decoded = decodeDataDescriptorFromJson(value);
      if (decoded) {
        const signature = `${vdxfKey}:${JSON.stringify(value)}`;
        if (!visited.has(signature)) {
          visited.add(signature);
          descriptors.push({ vdxfKey, ...decoded });
        }
      }
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (key !== 'serializedhex' && key !== 'objectdata' && key !== 'version' && key !== 'flags') {
        visit(vdxfKey, child);
      }
    }
  }

  for (const [vdxfKey, value] of Object.entries(contentmultimap || {})) {
    visit(vdxfKey, value);
  }
  return descriptors;
}

function extractUrlRefsFromCmm(contentmultimap = {}) {
  const references = [];
  const visited = new Set();

  for (const entry of extractDataDescriptorsFromCmm(contentmultimap)) {
    if (entry.urlRef) {
      const signature = `${entry.vdxfKey}:${entry.urlRef.url}:${entry.urlRef.datahash || ''}`;
      if (visited.has(signature)) continue;
      visited.add(signature);
      references.push({
        vdxfKey: entry.vdxfKey,
        ...entry.urlRef,
        dataDescriptor: {
          version: entry.version,
          flags: entry.flags,
          label: entry.label,
          mimeType: entry.mimeType,
          hasEncryptedData: entry.hasEncryptedData,
          innerType: entry.innerType,
        },
      });
    }
  }
  return references;
}

function extractCidsFromUrlRefs(references = []) {
  const cidPattern = /\b(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z2-7]{50,})\b/g;
  const cids = new Set();
  for (const reference of references) {
    cidPattern.lastIndex = 0;
    let match;
    while ((match = cidPattern.exec(reference.url || '')) !== null) cids.add(match[1]);
  }
  return cids;
}

/**
 * Build the Verus updateidentity `data` wrapper entry for daemon-managed native storage.
 * The filename is interpreted by the developer's own verusd process, not by SovPin.
 */
function buildNativeDataContentMultiMapEntry({
  identityName,
  vdxfId,
  filename,
  label,
  mimeType,
  createMmr = true,
}) {
  if (typeof identityName !== 'string' || !identityName.trim()) {
    throw new TypeError('identityName is required');
  }
  if (typeof vdxfId !== 'string' || !vdxfId.trim()) {
    throw new TypeError('vdxfId must be resolved with getvdxfid');
  }
  if (typeof filename !== 'string' || !filename.trim() || filename.includes('\0')) {
    throw new TypeError('filename must be a non-empty path readable by the developer\'s verusd');
  }

  const data = {
    address: identityName.trim(),
    filename: filename.trim(),
    createmmr: Boolean(createMmr),
  };
  if (typeof label === 'string' && label.trim()) data.label = label.trim();
  if (typeof mimeType === 'string' && mimeType.trim()) data.mimetype = mimeType.trim();

  return { [vdxfId]: [{ data }] };
}

module.exports = {
  buildUrlRefCmmValue,
  decodeDataDescriptorCmmValue,
  decodeUrlRefCmmValue,
  extractDataDescriptorsFromCmm,
  extractUrlRefsFromCmm,
  extractCidsFromUrlRefs,
  buildNativeDataContentMultiMapEntry,
};
