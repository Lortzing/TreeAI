import { test } from "node:test";
import assert from "node:assert/strict";
import { FIXTURES } from "./content.mjs";
import { FIXTURE_GROUP as F1 } from "./content/fixtures-01-03.mjs";
import { FIXTURE_GROUP as F2 } from "./content/fixtures-04-06.mjs";
import { FIXTURE_GROUP as F3 } from "./content/fixtures-07-09.mjs";
import { FIXTURE_GROUP as F4 } from "./content/fixtures-10-12.mjs";

test("B1 frozen PDF fixture registry retains every ID, order, and render routine", () => {
  const groups = [F1, F2, F3, F4];
  assert.deepEqual(groups.map(group => group.length), [3,3,3,3]);
  assert.deepEqual(FIXTURES, groups.flat(), "public registry must use exactly the original fixture objects");
  assert.deepEqual(FIXTURES.map(f=>f.id), Array.from({length:12},(_,i)=>`pdf-${String(i+1).padStart(2,"0")}`));
  for(const fixture of FIXTURES){
    assert.ok(typeof fixture.build === "function");
    assert.ok(fixture.title.length > 0);
    assert.ok(fixture.expectPages >= 1);
  }
});
