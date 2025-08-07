#!/usr/bin/env python
"""
Reproduce astropy issue #12907: separability_matrix incorrect for nested CompoundModels
"""
from astropy.modeling import models as m
from astropy.modeling.separable import separability_matrix

# Create the nested compound model as described in the issue
cm = m.Linear1D(10) & m.Linear1D(5)
nested_cm = m.Mapping([0, 1, 0, 1]) | cm
print("Nested CompoundModel structure:")
print(f"Model: {nested_cm}")
print()

# Get the separability matrix
sep_matrix = separability_matrix(nested_cm)
print("Current separability_matrix output:")
print(sep_matrix)
print()

# Expected output should be:
# [[True, True], [True, True]]
# But currently returns:
# [[True, False], [False, True]]

print("Expected separability_matrix:")
print("[[True, True], [True, True]]")
print()

# Additional test case with different nesting
cm2 = m.Gaussian2D(1, 2, 3, 4, 5) + m.Planar2D(1, 2, 3)
print("Another nested model:")
print(f"Model: {cm2}")
sep_matrix2 = separability_matrix(cm2)
print("Separability matrix:")
print(sep_matrix2)