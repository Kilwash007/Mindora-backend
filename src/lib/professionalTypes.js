// The professional types a practitioner can register as. Must match the
// ProfessionalType enum in prisma/schema.prisma — adding a type means
// updating both places (plus the frontend labels in
// src/data/professionalTypes.js).
export const PROFESSIONAL_TYPES = [
  'COUNSELLOR',
  'PSYCHOLOGIST',
  'CLINICAL_PSYCHOLOGIST',
  'PSYCHIATRIST',
  'PSYCHIATRIC_CLINICAL_OFFICER',
  'PSYCHIATRIC_NURSE',
]