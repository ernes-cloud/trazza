-- Sobres libres: una meta puede no tener importe objetivo ni fecha límite.
--
-- El modelo original asumía "ahorrar X para el día Y", lo que obliga a inventarse
-- un objetivo y una fecha para conceptos que no los tienen ("gasolina",
-- "restaurante"): son sobres donde vas apartando dinero sin meta que alcanzar.
-- Con ambas columnas anulables, una MISMA tabla cubre los dos casos y la UI
-- decide qué pintar (barra de progreso y ritmo mensual solo cuando hay objetivo).
--
-- El CHECK (target_amount > 0) NO se toca: en SQL una comparación con NULL da
-- NULL, que la restricción considera satisfecha, así que sigue prohibiendo el 0
-- y los negativos sin estorbar a los sobres libres.
ALTER TABLE savings_goals ALTER COLUMN target_amount DROP NOT NULL;
ALTER TABLE savings_goals ALTER COLUMN target_date   DROP NOT NULL;
