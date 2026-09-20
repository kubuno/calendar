-- Couleur optionnelle par événement. NULL = hérite de la couleur du calendrier.
ALTER TABLE calendar.events ADD COLUMN IF NOT EXISTS color VARCHAR(7);
