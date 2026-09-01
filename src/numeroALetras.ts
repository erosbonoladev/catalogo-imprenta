// Conversión de número a texto en español para el campo "Precio en texto" de
// la remisión. El resultado siempre precede a un sustantivo (MIL, MILLÓN,
// PESOS), así que el 1 usa siempre la forma apocopada "UN"/"VEINTIÚN", nunca
// "UNO"/"VEINTIUNO".

const UNIDADES = ["", "UN", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO", "NUEVE"];
const ESPECIALES_10_19 = [
  "DIEZ",
  "ONCE",
  "DOCE",
  "TRECE",
  "CATORCE",
  "QUINCE",
  "DIECISÉIS",
  "DIECISIETE",
  "DIECIOCHO",
  "DIECINUEVE",
];
const ESPECIALES_20_29 = [
  "VEINTE",
  "VEINTIÚN",
  "VEINTIDÓS",
  "VEINTITRÉS",
  "VEINTICUATRO",
  "VEINTICINCO",
  "VEINTISÉIS",
  "VEINTISIETE",
  "VEINTIOCHO",
  "VEINTINUEVE",
];
const DECENAS: Record<number, string> = {
  3: "TREINTA",
  4: "CUARENTA",
  5: "CINCUENTA",
  6: "SESENTA",
  7: "SETENTA",
  8: "OCHENTA",
  9: "NOVENTA",
};
const CENTENAS = [
  "",
  "CIENTO",
  "DOSCIENTOS",
  "TRESCIENTOS",
  "CUATROCIENTOS",
  "QUINIENTOS",
  "SEISCIENTOS",
  "SETECIENTOS",
  "OCHOCIENTOS",
  "NOVECIENTOS",
];

function convertTens(n: number): string {
  if (n < 10) return UNIDADES[n];
  if (n < 20) return ESPECIALES_10_19[n - 10];
  if (n < 30) return ESPECIALES_20_29[n - 20];
  const d = Math.floor(n / 10);
  const u = n % 10;
  return u === 0 ? DECENAS[d] : `${DECENAS[d]} Y ${UNIDADES[u]}`;
}

function convertGroup(n: number): string {
  if (n === 0) return "";
  if (n === 100) return "CIEN";
  const c = Math.floor(n / 100);
  const resto = n % 100;
  const parts: string[] = [];
  if (c > 0) parts.push(CENTENAS[c]);
  if (resto > 0) parts.push(convertTens(resto));
  return parts.join(" ");
}

function numberToWords(n: number): string {
  if (n === 0) return "CERO";
  const millones = Math.floor(n / 1_000_000);
  const restoMillones = n % 1_000_000;
  const miles = Math.floor(restoMillones / 1000);
  const resto = restoMillones % 1000;

  const parts: string[] = [];
  if (millones > 0) {
    parts.push(millones === 1 ? "UN MILLÓN" : `${numberToWords(millones)} MILLONES`);
  }
  if (miles > 0) {
    parts.push(miles === 1 ? "MIL" : `${convertGroup(miles)} MIL`);
  }
  if (resto > 0) {
    parts.push(convertGroup(resto));
  }
  return parts.join(" ");
}

export function numeroATextoMoneda(total: number): string {
  const rounded = Math.round(Math.abs(total) * 100) / 100;
  const enteros = Math.floor(rounded);
  const centavos = Math.round((rounded - enteros) * 100);
  const prefix = total < 0 ? "MENOS " : "";

  let pesosWord: string;
  if (enteros === 0) {
    pesosWord = "CERO PESOS";
  } else if (enteros === 1) {
    pesosWord = "UN PESO";
  } else {
    pesosWord = `${numberToWords(enteros)} PESOS`;
  }

  const centavosStr = String(centavos).padStart(2, "0");
  return `${prefix}${pesosWord} ${centavosStr}/100 MXN`;
}
