#pragma once
#include <stdint.h>
#include <strings.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>
typedef unsigned char BYTE; typedef short WORD; typedef uint32_t DWORD; typedef long LONG; typedef unsigned long ULONG; typedef int BOOL;
#pragma pack(push,1)
typedef struct { WORD bfType; DWORD bfSize; WORD bfReserved1, bfReserved2; DWORD bfOffBits; } BITMAPFILEHEADER;
typedef struct { DWORD biSize; LONG biWidth, biHeight; WORD biPlanes, biBitCount; DWORD biCompression, biSizeImage; LONG biXPelsPerMeter, biYPelsPerMeter; DWORD biClrUsed, biClrImportant; } BITMAPINFOHEADER;
typedef struct { BYTE rgbBlue, rgbGreen, rgbRed, rgbReserved; } RGBQUAD;
#pragma pack(pop)
#define BI_RGB 0
#define stricmp strcasecmp
#define strnicmp strncasecmp
#define _stricmp strcasecmp
#define _strnicmp strncasecmp
#define MAX_PATH 260
#define strcmpi strcasecmp
#define MAKEWORD(a,b) ((WORD)(((BYTE)(a))|(((WORD)((BYTE)(b)))<<8)))
