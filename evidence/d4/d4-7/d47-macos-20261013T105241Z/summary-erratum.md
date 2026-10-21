# Evidence text correction

The original summary's “运行前不存在=false” interpolates `dataDirExistedBefore`, so the label is inverted. The precondition recorded `dataDirExistedBefore=false`: the test directory **did not exist** before this run and did not exist after cleanup. The original summary, commands and environment are retained; 55 PASS / 0 FAIL is unchanged. The generator is corrected to interpolate `!dataDirExistedBefore` for the next run. This engineering test does not substitute for owner signoff.
