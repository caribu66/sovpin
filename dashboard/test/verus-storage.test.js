const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildUrlRefCmmValue,
  decodeDataDescriptorCmmValue,
  decodeUrlRefCmmValue,
  extractDataDescriptorsFromCmm,
  extractUrlRefsFromCmm,
  extractCidsFromUrlRefs,
  buildNativeDataContentMultiMapEntry,
} = require('../src/verus-storage');

test('Verus URLRef CMM value round-trips URL and byte hash', () => {
  const url = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uhdpx4gd5x2u7n2h7yq5v5y5q5q5q5q5q';
  const sha256Hex = 'ab'.repeat(32);
  const built = buildUrlRefCmmValue({ url, sha256Hex });

  assert.equal(built.urlRef.version, 2);
  assert.equal(built.urlRef.flags, 1);
  assert.equal(built.urlRef.url, url);
  assert.equal(built.urlRef.datahash, sha256Hex);
  assert.deepEqual(decodeUrlRefCmmValue(built.serializedhex), built.urlRef);
});

test('Verus URLRef can be encoded without asserting an unverified byte hash', () => {
  const url = 'ipfs://QmYwAPJzv5CZsnAzt8auVZRnGi2DqxHzJ9t5zL54fV6K3W';
  const built = buildUrlRefCmmValue({ url });

  assert.equal(built.urlRef.url, url);
  assert.equal(built.urlRef.flags, 0);
  assert.equal(built.urlRef.datahash, '');
  assert.deepEqual(decodeUrlRefCmmValue(built.serializedhex), built.urlRef);
});

test('URLRef builder rejects malformed content hashes', () => {
  assert.throws(
    () => buildUrlRefCmmValue({ url: 'ipfs://example', sha256Hex: 'not-a-sha256' }),
    /32-byte hexadecimal digest/
  );
});

test('URLRef decoder returns null for invalid or non-URLRef data', () => {
  assert.equal(decodeUrlRefCmmValue('xyz'), null);
  assert.equal(decodeUrlRefCmmValue('00'), null);
});

test('CMM URLRef extraction reads the Verus serializedhex value shape and preserves DataDescriptor metadata', () => {
  const cid = 'QmYwAPJzv5CZsnAzt8auVZRnGi2DqxHzJ9t5zL54fV6K3W';
  const entry = buildUrlRefCmmValue({
    url: `ipfs://${cid}`,
    sha256Hex: 'cd'.repeat(32),
    label: 'genesis-artifact.json',
    mimeType: 'application/json',
  });
  const decodedDescriptor = decodeDataDescriptorCmmValue(entry.serializedhex);
  assert.equal(decodedDescriptor.version, 1);
  assert.equal(decodedDescriptor.flags, 96); // 0x20 (FLAG_LABEL_PRESENT) | 0x40 (FLAG_MIME_TYPE_PRESENT)
  assert.equal(decodedDescriptor.hasLabel, true);
  assert.equal(decodedDescriptor.hasMimeType, true);
  assert.equal(decodedDescriptor.hasEncryptedData, false);
  assert.equal(decodedDescriptor.label, 'genesis-artifact.json');
  assert.equal(decodedDescriptor.mimeType, 'application/json');
  assert.equal(decodedDescriptor.innerType, 'URLRef');

  const allDescriptors = extractDataDescriptorsFromCmm({
    iExampleVdxfKey: [{ serializedhex: entry.serializedhex }],
  });
  assert.equal(allDescriptors.length, 1);
  assert.equal(allDescriptors[0].flags, 96);

  const refs = extractUrlRefsFromCmm({
    iExampleVdxfKey: [{ serializedhex: entry.serializedhex }],
  });

  assert.equal(refs.length, 1);
  assert.equal(refs[0].vdxfKey, 'iExampleVdxfKey');
  assert.equal(refs[0].url, `ipfs://${cid}`);
  assert.equal(refs[0].datahash, 'cd'.repeat(32));
  assert.equal(refs[0].dataDescriptor.flags, 96);
  assert.equal(refs[0].dataDescriptor.label, 'genesis-artifact.json');
  assert.equal(refs[0].dataDescriptor.mimeType, 'application/json');
  assert.equal(refs[0].dataDescriptor.innerType, 'URLRef');
  assert.deepEqual([...extractCidsFromUrlRefs(refs)], [cid]);
});

test('native storage helper emits the standard updateidentity data wrapper entry', () => {
  const entry = buildNativeDataContentMultiMapEntry({
    identityName: 'myapp@',
    vdxfId: 'iExampleVdxfKey',
    filename: '/app/data/archive.bin',
    label: 'archive-001',
    mimeType: 'application/octet-stream',
  });

  assert.deepEqual(entry, {
    iExampleVdxfKey: [
      {
        data: {
          address: 'myapp@',
          filename: '/app/data/archive.bin',
          createmmr: true,
          label: 'archive-001',
          mimetype: 'application/octet-stream',
        },
      },
    ],
  });
});

test('native storage helper rejects a filename that cannot be passed safely to verusd', () => {
  assert.throws(
    () => buildNativeDataContentMultiMapEntry({
      identityName: 'myapp@',
      vdxfId: 'iExampleVdxfKey',
      filename: 'bad\0path',
    }),
    /filename must be a non-empty path/
  );
});
