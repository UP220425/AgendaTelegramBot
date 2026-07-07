# Onboarding de usuarios en Telegram

## Como entregar accesos

No mandes el archivo completo de claves al grupo.

El archivo local `data/claves-usuarios-telegram.txt` es solo para Carlos/Diego. A cada persona se le debe mandar solamente su propia linea.

Ejemplo de mensaje privado:

```text
Hola. Para entrar al Agenda Coordinacion Bot:

1. Abre el bot en Telegram.
2. Escribe: /soy Tu Nombre
3. Escribe: /clave TU_CLAVE

Tu clave es: TU_CLAVE
```

## Como entra cada usuario

```text
/soy Nombre
/clave contraseña
```

Ejemplo:

```text
/soy Carlos
/clave xxxx-xxxx-xxxx
```

## Como cambiar una contraseña

Solo Carlos o Diego pueden hacerlo desde el bot.

Ruta con botones:

```text
Menu principal -> Gestionar personas -> Cambiar contraseña
```

Tambien se puede usar comando:

```text
/clavepersona Nombre | nueva_contraseña
```

## Como agregar una persona

Solo Carlos o Diego:

```text
Menu principal -> Gestionar personas -> Agregar persona
```

Despues de escribir el nombre, el bot pedira la contraseña inicial de esa persona.

## Como dar de baja una persona

Solo Carlos o Diego:

```text
Menu principal -> Gestionar personas -> Dar de baja persona
```

Cuando se da de baja una persona:

- deja de aparecer en botones
- se revoca su acceso
- se desactiva su contraseña
- deja de recibir recordatorios por perfil

## Importante para despliegues

Las claves reales y hashes viven en `data/`, y `data/` no se sube a Git por seguridad.

Si el bot se mueve a otra computadora o servidor, hay que copiar de forma privada:

```text
data/personPasswords.json
data/peopleDirectory.json, si existe
```

No compartas esos archivos en grupos.
