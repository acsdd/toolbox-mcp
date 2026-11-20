# Model Farm 0.9.4

## Remote modules: public HTTPS only

Remote marketplace modules used to be handed to the HTTP client as-is. The
server now applies an endpoint policy before it connects:

- only `https://` endpoints are accepted, and URLs may not carry credentials;
- `localhost`, `*.localhost`, `*.local`, `*.internal` and `*.home.arpa` are
  refused outright;
- literal addresses in loopback, private, link-local, carrier-grade NAT,
  multicast, documentation and other reserved ranges are refused (IPv4 and
  IPv6, including IPv4-mapped and NAT64 forms);
- a hostname is resolved first, and **every** answer must be a public address,
  so a public name that points back into the local machine or a private
  network is refused with a message naming the address.

The refusal is reported where the install or reconnect failed (`remote_status`
and the Marketplace card), and the panel now states the rule next to a remote
endpoint. DNS can change between the check and the connection; the guard is one
layer, not full protection against a hostile public endpoint.

## Model Farm downloads

- The progress row now shows the current download rate and the estimated time
  left, computed from consecutive polls.
- A failed or cancelled install offers **Retry install**; the chosen
  quantization is reused.
- **cancel** still stops GGUF downloads from the panel or the
  `llamafarm_cancel` tool. Ollama-owned pulls cannot be cancelled from here and
  say so.

## Verification

`npm test` — 274 tests, including the new endpoint-policy suite (https-only,
loopback/private/link-local/CGNAT literals, multi-answer DNS, IPv6 ULA and
mapped forms, credential-carrying URLs) and the panel affordance checks.
