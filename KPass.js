import { __decorate, __metadata, __param } from "tslib";
import { Circuit, circuitMain, public_ } from "./dist/cloudflare/lib/proof-system/circuit.js";
import { Gadgets } from "./dist/cloudflare/lib/provable/gadgets/gadgets.js";
import { Field } from "./dist/cloudflare/lib/provable/wrapped.js";

class C extends Circuit {
  /**
   * @param {!Field} x
   * @param {!Field} y
   */
  static f(x, y) {
    Gadgets.rangeCheck64(y);
    /** @const {!Field} */
    const y3 = y.square().mul(y);
    y3.assertEquals(x);
  }
}

__decorate(
  [
    circuitMain,
    __param(0, public_),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Field, Field]),
    __metadata("design:returntype", void 0),
  ],
  C,
  "f",
  null
);

console.time("generating keypair...");
const kp = await C.generateKeypair();
console.timeEnd("generating keypair...");

console.time("prove...");
const x = Field(729);
const y = Field(9);
const proof = await C.prove([y], [x], kp);
console.timeEnd("prove...");

console.time("verify...");
let vk = kp.verificationKey();
let ok = await C.verify([x], vk, proof);
console.timeEnd("verify...");
console.log("ok?", ok);
