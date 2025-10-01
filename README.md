# strfry-ecash-plugin-dvm-demo
Proof of concept and performance test of using ecash for rate-limiting relay communications to DVMs on Nostr, using a [Strfry](https://github.com/hoytech/strfry) relay, [CDK](https://github.com/cashubtc/cdk) Cashu mint.

# Components
Each of these is it's own docker container:

1. [CDK](https://github.com/cashubtc/cdk) Mint that issues ecash and offers microsat denominations (1 micro sat = 1 millionth of a sat).
2. [Strfry](https://github.com/hoytech/strfry) relay w/ a plugin that checks ecash is valid with our mint, and consumes it with the mint (basically spending it).
3. Webserver hosts a website that supports two main features: (1) a faucet to get free ecash and (2) a site that let's us run performance tests to see how fast we can interact with a DVM using ecash for rate limiting. The performance tests are the primary goal of this entire project.
4. DVM container running DVMs that are available at this relay, running DVMs using NIP-17's encrypted DVMs.


